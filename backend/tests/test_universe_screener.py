"""Automated tests for Phase 5C: Backend Bulk Market-Data Screener Service and Authenticated Endpoint."""

import asyncio
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.schemas.universe import (
    ConstituentScreenResultRead,
    LargeCapUniverse,
    UniverseConstituent,
    UniverseMetadata,
    UniverseScreenResponse,
)
from app.services.market_data.base import (
    MarketDataProvider,
    MarketQuote,
    WeeklyCandle,
)
from app.services.market_data.cache import MarketDataCache
from app.services.market_data.calendar import IST
from app.services.market_data.errors import (
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
)
from app.services.market_data.indicators import (
    calculate_twenty_week_sma,
    calculate_wilders_rsi,
)
from app.services.market_data.service import MarketDataService
from app.services.market_data.universe_ingest import save_universe_artifact
from app.services.market_data.universe_screener import (
    ConstituentScreenResult,
    UniverseScreenerService,
)
from app.services.market_data.universe_service import (
    UniverseNotAvailableError,
    UniverseService,
)
from tests.conftest import upgrade_database


def generate_synthetic_universe(
    effective_from: date = date(2026, 7, 1),
    effective_to: date = date(2026, 12, 31),
    dataset_version: str = "2026-H2-v1",
    classification_period: str = "July - December 2026",
    source_period_label: str = "July - December 2026",
    constituent_count: int = 100,
    start_rank: int = 1,
) -> LargeCapUniverse:
    """Generate a valid synthetic LargeCapUniverse instance with exactly constituent_count items."""
    constituents: list[UniverseConstituent] = []
    for rank in range(start_rank, start_rank + constituent_count):
        isin = f"INE{rank:09d}"
        symbol = f"SYNTH{rank}"
        constituents.append(
            UniverseConstituent(
                rank=rank,
                isin=isin,
                company_name=f"Synthetic Co {rank} Ltd",
                source_symbol=symbol,
                canonical_nse_symbol=symbol,
                upstox_instrument_key=f"NSE_EQ|{isin}",
            )
        )

    metadata = UniverseMetadata(
        dataset_version=dataset_version,
        source_name="AMFI",
        source_period_label=source_period_label,
        classification_period=classification_period,
        effective_from=effective_from,
        effective_to=effective_to,
        source_reference="synthetic_screener.csv",
        sha256_checksum="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        verified_at=datetime.now(timezone.utc),
        constituent_count=len(constituents),
    )
    return LargeCapUniverse(metadata=metadata, constituents=constituents)


def make_weekly_candles(
    symbol: str,
    count: int = 60,
    base_price: float = 1000.0,
    trend: str = "up",  # "up", "down", "flat", or "alternating"
) -> list[WeeklyCandle]:
    """Generate synthetic weekly candles with deterministic price sequences."""
    candles: list[WeeklyCandle] = []
    curr = base_price

    for i in range(count):
        c_date = date(2025, 1, 3) + timedelta(days=7 * i)
        if trend == "up":
            # Consistently rising closes -> High RSI > 70
            curr += 15.0
        elif trend == "down":
            # Consistently falling closes -> Low RSI < 30
            curr = max(100.0, curr - 15.0)
        elif trend == "alternating":
            # Gains of 1.5 and losses of 1.0 alternating -> RS = 1.5 -> RSI = 60.0
            if i % 2 == 1:
                curr += 1.5
            else:
                curr -= 1.0
        # "flat": no price change -> RSI = 50.0

        p = Decimal(str(round(curr, 2)))
        candles.append(
            WeeklyCandle(
                symbol=symbol,
                candle_date=c_date,
                open_price=p,
                high_price=p + Decimal("10.00"),
                low_price=max(Decimal("1.00"), p - Decimal("10.00")),
                close_price=p,
                volume=50000,
                is_completed=True,
            )
        )
    return candles


class MockScreenerProvider(MarketDataProvider):
    """Deterministic mock market data provider for screener testing."""

    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self.clock = clock or (lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc))
        self.quotes: dict[str, MarketQuote] = {}
        self.candles: dict[str, list[WeeklyCandle]] = {}
        self.quote_calls = 0
        self.batch_quote_calls = 0
        self.candle_calls = 0
        self.active_concurrency = 0
        self.max_concurrency_seen = 0
        self.candle_exceptions: dict[str, Exception] = {}
        self.rate_limit_triggered = False

    async def get_instrument_identifier(self, symbol: str) -> str | None:
        return f"NSE_EQ|INE{symbol}"

    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        self.quote_calls += 1
        norm = symbol.strip().upper()
        if norm in self.quotes:
            return self.quotes[norm]
        return MarketQuote(
            symbol=norm,
            instrument_identifier=f"NSE_EQ|INE{norm}",
            last_price=Decimal("1500.00"),
            timestamp=self.clock(),
            source="UPSTOX",
            is_stale=False,
        )

    async def get_reference_quotes_batch(self, symbols: list[str]) -> dict[str, MarketQuote]:
        self.batch_quote_calls += 1
        results: dict[str, MarketQuote] = {}
        for sym in symbols:
            norm = sym.strip().upper()
            if norm in self.quotes:
                results[norm] = self.quotes[norm]
            else:
                results[norm] = MarketQuote(
                    symbol=norm,
                    instrument_identifier=f"NSE_EQ|INE{norm}",
                    last_price=Decimal("1500.00"),
                    timestamp=self.clock(),
                    source="UPSTOX",
                    is_stale=False,
                )
        return results

    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        self.candle_calls += 1
        self.active_concurrency += 1
        if self.active_concurrency > self.max_concurrency_seen:
            self.max_concurrency_seen = self.active_concurrency

        norm = symbol.strip().upper()
        try:
            # Simulate slight async work to test concurrency bounds
            await asyncio.sleep(0.001)

            if norm in self.candle_exceptions:
                raise self.candle_exceptions[norm]

            if norm in self.candles:
                return self.candles[norm]

            # Default: 60 upward candles (RSI > 60)
            return make_weekly_candles(norm, count=60, trend="up")
        finally:
            self.active_concurrency -= 1


@pytest.fixture
def screener_app_and_client(tmp_path):
    """Set up test FastAPI app with temporary database, universe artifact, and mock screener service."""
    db_file = tmp_path / "screener_test.db"
    database_url = f"sqlite:///{db_file.as_posix()}"
    upgrade_database(database_url)

    universe_file = tmp_path / "universe" / "nse_largecap_current.json"
    universe_file.parent.mkdir(parents=True, exist_ok=True)

    settings = Settings(
        database_url=database_url,
        registration_enabled=True,
        large_cap_universe_path=str(universe_file),
    )

    test_clock = [datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc)]
    mock_provider = MockScreenerProvider(clock=lambda: test_clock[0])
    md_service = MarketDataService(provider=mock_provider)
    u_service = UniverseService(
        artifact_path=universe_file,
        clock=lambda: test_clock[0].date(),
    )
    screener_service = UniverseScreenerService(
        universe_service=u_service,
        provider=mock_provider,
        settings=settings,
        clock=lambda: test_clock[0],
        concurrency_limit=5,
    )

    app = create_app(
        settings=settings,
        market_data_service=md_service,
        universe_service=u_service,
        universe_screener_service=screener_service,
    )

    with TestClient(app, base_url="https://testserver") as client:
        yield client, screener_service, u_service, mock_provider, universe_file, test_clock


def authenticate(client: TestClient, email: str = "screener_user@example.com") -> str:
    res = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": email, "password": "secure-screener-password-456"},
    )
    assert res.status_code == 201
    return res.json()["id"]


# =========================================================================
# Scenario 1: Fully valid 100-constituent universe screening
# =========================================================================
@pytest.mark.anyio
async def test_fully_valid_100_constituent_screening(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    assert isinstance(response, UniverseScreenResponse)
    assert response.total_constituents == 100
    assert len(response.results) == 100
    assert response.universe_version == "2026-H2-v1"
    assert response.classification_period == "July - December 2026"

    # Verify rank order 1 to 100
    for idx, r in enumerate(response.results, start=1):
        assert r.rank == idx
        assert r.canonical_nse_symbol == f"SYNTH{idx}"
        assert r.is_qualified is True
        assert r.diagnostic_status == "QUALIFIED"


# =========================================================================
# Scenario 2: Stocks qualifying when RSI is strictly greater than 60
# =========================================================================
@pytest.mark.anyio
async def test_stocks_qualify_when_rsi_strictly_greater_than_60(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe(constituent_count=100)
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    # SYNTH1: Upward trend (RSI > 70)
    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=60, trend="up")
    # SYNTH2: Downward trend (RSI < 40)
    provider.candles["SYNTH2"] = make_weekly_candles("SYNTH2", count=60, trend="down")

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]
    r2 = response.results[1]

    assert r1.canonical_nse_symbol == "SYNTH1"
    assert r1.weekly_rsi is not None and r1.weekly_rsi > 60.0
    assert r1.is_qualified is True
    assert r1.diagnostic_status == "QUALIFIED"

    assert r2.canonical_nse_symbol == "SYNTH2"
    assert r2.weekly_rsi is not None and r2.weekly_rsi <= 60.0
    assert r2.is_qualified is False
    assert r2.diagnostic_status == "NOT_QUALIFIED"


# =========================================================================
# Scenario 3: RSI equal to 60 is ineligible (strict greater than)
# =========================================================================
@pytest.mark.anyio
async def test_rsi_equal_to_60_is_not_qualified(tmp_path, monkeypatch):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    # Deterministically enforce RSI == 60.0000 for SYNTH1 to verify strict inequality (> 60)
    import app.services.market_data.universe_screener as screener_mod
    from app.services.market_data.base import TechnicalIndicators

    orig_calc = screener_mod.calculate_technical_indicators

    def mock_calc(symbol, candles):
        res = orig_calc(symbol, candles)
        if symbol == "SYNTH1":
            return TechnicalIndicators(
                symbol=symbol,
                twenty_week_sma=res.twenty_week_sma or Decimal("1500.00"),
                weekly_rsi=Decimal("60.0000"),
                latest_completed_candle_date=res.latest_completed_candle_date,
                completed_candles_count=res.completed_candles_count or 60,
                is_valid=True,
            )
        return res

    monkeypatch.setattr(screener_mod, "calculate_technical_indicators", mock_calc)

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]

    assert r1.weekly_rsi == 60.0
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "NOT_QUALIFIED"
    assert "not strictly greater than 60" in (r1.diagnostic_reason or "").lower()


# =========================================================================
# Scenario 4: Price and SMA displayed without price-above-SMA qualification condition
# =========================================================================
@pytest.mark.anyio
async def test_price_below_sma_still_qualifies_when_rsi_greater_than_60(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    # Candles produce SMA = 1500, but last_price = 1200 (price < SMA)
    candles = make_weekly_candles("SYNTH1", count=60, base_price=1000.0, trend="up")
    provider.candles["SYNTH1"] = candles
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("1200.00"),  # Strictly below 20-week SMA
        timestamp=datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
        source="UPSTOX",
        is_stale=False,
    )

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]

    assert r1.last_price == 1200.0
    assert r1.twenty_week_sma is not None
    assert r1.last_price < r1.twenty_week_sma  # Price is below SMA!
    assert r1.weekly_rsi is not None and r1.weekly_rsi > 60.0
    # Must still qualify! (No price > SMA rule in Phase 5C)
    assert r1.is_qualified is True
    assert r1.diagnostic_status == "QUALIFIED"


# =========================================================================
# Scenario 5: Stale quotes never qualify
# =========================================================================
@pytest.mark.anyio
async def test_stale_quotes_never_qualify(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("2000.00"),
        timestamp=datetime(2026, 8, 10, 10, 0, tzinfo=timezone.utc),
        source="UPSTOX",
        is_stale=True,  # Stale quote!
    )

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]

    assert r1.is_stale is True
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "STALE_QUOTE"


# =========================================================================
# Scenario 6: Missing or insufficient weekly-candle history
# =========================================================================
@pytest.mark.anyio
async def test_insufficient_weekly_candle_history(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    # 1. 19 completed candles: insufficient history for both SMA and RSI
    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=19)
    # 2. 20 completed candles: SMA available, but RSI requires 50
    provider.candles["SYNTH2"] = make_weekly_candles("SYNTH2", count=20)
    # 3. 49 completed candles: SMA available, but RSI requires 50
    provider.candles["SYNTH3"] = make_weekly_candles("SYNTH3", count=49)
    # 4. 50 completed candles with upward trend: both SMA and RSI available, qualifies
    provider.candles["SYNTH4"] = make_weekly_candles("SYNTH4", count=50, trend="up")
    # 5. 50 completed candles with downward trend: both SMA and RSI available, does not qualify
    provider.candles["SYNTH5"] = make_weekly_candles("SYNTH5", count=50, trend="down")
    # 6. 0 candles: insufficient history for both SMA and RSI
    provider.candles["SYNTH6"] = []

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]
    r2 = response.results[1]
    r3 = response.results[2]
    r4 = response.results[3]
    r5 = response.results[4]
    r6 = response.results[5]

    # 19 candles: both unavailable
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "INSUFFICIENT_HISTORY"
    assert r1.twenty_week_sma is None
    assert r1.weekly_rsi is None
    assert "19/20 required for SMA" in r1.diagnostic_reason
    assert "50 required for RSI" in r1.diagnostic_reason

    # 20 candles: SMA available, RSI unavailable -> INSUFFICIENT_HISTORY, not qualified
    assert r2.is_qualified is False
    assert r2.diagnostic_status == "INSUFFICIENT_HISTORY"
    assert r2.twenty_week_sma is not None
    assert r2.weekly_rsi is None
    assert "20/50 required" in r2.diagnostic_reason
    assert "20-week SMA is available" in r2.diagnostic_reason

    # 49 candles: SMA available, RSI unavailable -> INSUFFICIENT_HISTORY, not qualified
    assert r3.is_qualified is False
    assert r3.diagnostic_status == "INSUFFICIENT_HISTORY"
    assert r3.twenty_week_sma is not None
    assert r3.weekly_rsi is None
    assert "49/50 required" in r3.diagnostic_reason
    assert "20-week SMA is available" in r3.diagnostic_reason

    # 50 candles (up trend): both available, RSI > 60 -> QUALIFIED
    assert r4.is_qualified is True
    assert r4.diagnostic_status == "QUALIFIED"
    assert r4.twenty_week_sma is not None
    assert r4.weekly_rsi is not None and r4.weekly_rsi > 60.0

    # 50 candles (down trend): both available, RSI <= 60 -> NOT_QUALIFIED
    assert r5.is_qualified is False
    assert r5.diagnostic_status == "NOT_QUALIFIED"
    assert r5.twenty_week_sma is not None
    assert r5.weekly_rsi is not None and r5.weekly_rsi <= 60.0

    # 0 candles
    assert r6.is_qualified is False
    assert r6.diagnostic_status == "INSUFFICIENT_HISTORY"
    assert r6.twenty_week_sma is None
    assert r6.weekly_rsi is None


# =========================================================================
# Scenario 7: Individual quote and historical-data failures
# =========================================================================
@pytest.mark.anyio
async def test_individual_quote_and_provider_failures(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    # Simulate quote missing for SYNTH1 by overriding batch return
    async def custom_batch(symbols):
        res = await MockScreenerProvider.get_reference_quotes_batch(provider, symbols)
        res.pop("SYNTH1", None)  # Omit SYNTH1
        return res

    provider.get_reference_quotes_batch = custom_batch

    # Simulate provider failure for SYNTH2
    provider.candle_exceptions["SYNTH2"] = MarketDataUnavailableError("Upstox candle timeout")

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]
    r2 = response.results[1]
    r3 = response.results[2]

    # SYNTH1 has quote unavailable
    assert r1.canonical_nse_symbol == "SYNTH1"
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "QUOTE_UNAVAILABLE"
    assert r1.last_price is None

    # SYNTH2 has provider error
    assert r2.canonical_nse_symbol == "SYNTH2"
    assert r2.is_qualified is False
    assert r2.diagnostic_status == "PROVIDER_ERROR"

    # SYNTH3 succeeds and is unaffected by other constituent errors
    assert r3.canonical_nse_symbol == "SYNTH3"
    assert r3.is_qualified is True
    assert r3.diagnostic_status == "QUALIFIED"


# =========================================================================
# Scenario 8: Bounded concurrency and batch quote calls
# =========================================================================
@pytest.mark.anyio
async def test_bounded_concurrency_and_batch_quotes(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    concurrency_limit = 4
    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        concurrency_limit=concurrency_limit,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    await screener.screen_universe(as_of_date=date(2026, 8, 15))

    # Verify batch quotes called
    assert provider.batch_quote_calls == 1
    # Verify max concurrent candle requests never exceeded configured semaphore limit
    assert provider.max_concurrency_seen <= concurrency_limit
    assert provider.max_concurrency_seen > 0


# =========================================================================
# Scenario 9: Cache hits, expiry, and quote freshness revalidation
# =========================================================================
@pytest.mark.anyio
async def test_screener_caching_and_quote_freshness_revalidation(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # Monday during NSE market hours (10:30 AM IST = 05:00 UTC)
    curr_time = [datetime(2026, 8, 17, 5, 0, tzinfo=timezone.utc)]

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: curr_time[0].date())
    provider = MockScreenerProvider(clock=lambda: curr_time[0])

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: curr_time[0],
    )

    # 1. Initial screen
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 17))
    assert res1.results[0].is_qualified is True
    assert provider.candle_calls == 100
    assert provider.batch_quote_calls == 1

    # 2. Subsequent call within cache TTL (10s later during trading) -> served from cache without provider calls
    curr_time[0] = curr_time[0] + timedelta(seconds=10)
    res2 = await screener.screen_universe(as_of_date=date(2026, 8, 17))
    assert provider.candle_calls == 100
    assert provider.batch_quote_calls == 1
    assert res2.qualified_count == res1.qualified_count
    assert res2.results[0].is_qualified is True

    # 3. Advance time past quote freshness window (120 seconds later) during market hours
    # The cached quote timestamp is now stale (> 60s)!
    curr_time[0] = curr_time[0] + timedelta(seconds=120)
    res3 = await screener.screen_universe(qualified_only=False, as_of_date=date(2026, 8, 17))
    # Cached items re-evaluated as STALE_QUOTE, never served as fresh!
    assert res3.results[0].is_stale is True
    assert res3.results[0].is_qualified is False
    assert res3.results[0].diagnostic_status == "STALE_QUOTE"
    assert res3.qualified_count == 0
    assert res3.total_constituents == 100
    assert len(res3.results) == 100

    # 4. Request qualified_only=True on stale cache
    # Must exclude stale constituents: results array is empty, matching qualified_count (0)
    res4 = await screener.screen_universe(qualified_only=True, as_of_date=date(2026, 8, 17))
    assert res4.total_constituents == 100
    assert res4.qualified_count == 0
    assert len(res4.results) == 0
    assert len(res4.results) == res4.qualified_count


@pytest.mark.anyio
async def test_cache_hit_selective_staleness_and_qualified_only_filter(tmp_path):
    """Verify that quote freshness revalidation on cache hit reduces qualifiedCount

    and excludes stale constituents from qualified_only=True without contradicting
    totalConstituents or qualifiedCount semantics.
    """
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # Monday during NSE trading hours: 05:00 UTC (10:30 AM IST)
    base_time = datetime(2026, 8, 17, 5, 0, tzinfo=timezone.utc)
    curr_time = [base_time]

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: curr_time[0].date())
    provider = MockScreenerProvider(clock=lambda: curr_time[0])

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: curr_time[0],
    )

    # 1. Initial screen: all 100 constituents qualify
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 17))
    assert res1.total_constituents == 100
    assert res1.qualified_count == 100
    assert len(res1.results) == 100

    # 2. Modify one quote directly in provider to test selective staleness
    # Force refresh screen with SYNTH1 fresh (age 10s) and SYNTH2 stale (age 90s)
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("1500.00"),
        timestamp=base_time - timedelta(seconds=10),
        source="UPSTOX",
        is_stale=False,
    )
    provider.quotes["SYNTH2"] = MarketQuote(
        symbol="SYNTH2",
        instrument_identifier="NSE_EQ|INESYNTH2",
        last_price=Decimal("1500.00"),
        timestamp=base_time - timedelta(seconds=90),  # Stale!
        source="UPSTOX",
        is_stale=False,
    )

    res_live = await screener.screen_universe(qualified_only=False, force_refresh=True, as_of_date=date(2026, 8, 17))
    assert res_live.results[0].canonical_nse_symbol == "SYNTH1"
    assert res_live.results[0].is_qualified is True
    assert res_live.results[1].canonical_nse_symbol == "SYNTH2"
    assert res_live.results[1].is_qualified is False
    assert res_live.results[1].is_stale is True
    assert res_live.results[1].diagnostic_status == "STALE_QUOTE"
    assert res_live.qualified_count == 99

    # 3. Query from cache with qualified_only=True
    res_qual = await screener.screen_universe(qualified_only=True, force_refresh=False, as_of_date=date(2026, 8, 17))
    assert res_qual.total_constituents == 100
    assert res_qual.qualified_count == 99
    assert len(res_qual.results) == 99
    symbols = [r.canonical_nse_symbol for r in res_qual.results]
    assert "SYNTH1" in symbols
    assert "SYNTH2" not in symbols
    assert all(r.is_qualified is True for r in res_qual.results)

    # 4. Advance time so SYNTH1 also expires (90 seconds later)
    curr_time[0] = curr_time[0] + timedelta(seconds=90)
    res_stale_qual = await screener.screen_universe(qualified_only=True, force_refresh=False, as_of_date=date(2026, 8, 17))
    assert res_stale_qual.total_constituents == 100
    assert res_stale_qual.qualified_count == 0  # All quotes now stale!
    assert len(res_stale_qual.results) == 0
    assert len(res_stale_qual.results) == res_stale_qual.qualified_count


# =========================================================================
# Scenario 10: Rank ordering and the qualified-only filter
# =========================================================================
@pytest.mark.anyio
async def test_rank_ordering_and_qualified_only_filter(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    clock_time = datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc)
    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: clock_time.date())
    provider = MockScreenerProvider(clock=lambda: clock_time)

    # Odd ranks: upward (qualified), Even ranks: downward (not qualified)
    for i in range(1, 101):
        sym = f"SYNTH{i}"
        trend = "up" if i % 2 == 1 else "down"
        provider.candles[sym] = make_weekly_candles(sym, count=60, trend=trend)

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_time,
    )

    # All constituents
    all_res = await screener.screen_universe(qualified_only=False, force_refresh=True)
    assert all_res.total_constituents == 100
    assert len(all_res.results) == 100
    assert all_res.qualified_count == 50
    assert [r.rank for r in all_res.results] == list(range(1, 101))

    # Qualified only
    qual_res = await screener.screen_universe(qualified_only=True, force_refresh=False)
    assert qual_res.total_constituents == 100
    assert len(qual_res.results) == 50
    assert qual_res.qualified_count == 50
    # All must have is_qualified == True and preserve rank order (1, 3, 5, ...)
    assert all(r.is_qualified for r in qual_res.results)
    assert [r.rank for r in qual_res.results] == [i for i in range(1, 101) if i % 2 == 1]


# =========================================================================
# Scenario 11: Non-valid universe states prevent screening
# =========================================================================
@pytest.mark.anyio
async def test_non_valid_universe_states_prevent_screening(tmp_path):
    artifact_path = tmp_path / "universe.json"

    # 1. Missing universe
    u_service_missing = UniverseService(artifact_path=tmp_path / "missing.json")
    screener_missing = UniverseScreenerService(
        universe_service=u_service_missing,
        provider=MockScreenerProvider(),
    )
    with pytest.raises(UniverseNotAvailableError) as exc_missing:
        await screener_missing.screen_universe()
    assert exc_missing.value.universe_status.status == "UNAVAILABLE"

    # 2. Expired universe
    u_expired = generate_synthetic_universe(
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 6, 30),
    )
    save_universe_artifact(u_expired, artifact_path)
    u_service_expired = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    screener_expired = UniverseScreenerService(
        universe_service=u_service_expired,
        provider=MockScreenerProvider(),
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )
    with pytest.raises(UniverseNotAvailableError) as exc_expired:
        await screener_expired.screen_universe()
    assert exc_expired.value.universe_status.status == "EXPIRED"

    # 3. Not yet active universe
    u_future = generate_synthetic_universe(
        effective_from=date(2027, 1, 1),
        effective_to=date(2027, 6, 30),
    )
    save_universe_artifact(u_future, artifact_path)
    u_service_future = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    screener_future = UniverseScreenerService(
        universe_service=u_service_future,
        provider=MockScreenerProvider(),
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )
    with pytest.raises(UniverseNotAvailableError) as exc_future:
        await screener_future.screen_universe()
    assert exc_future.value.universe_status.status == "NOT_YET_ACTIVE"


# =========================================================================
# Scenario 12 & 13: Endpoint authentication, filter, and HTTP error mapping
# =========================================================================
def test_screener_endpoint_auth_and_responses(screener_app_and_client):
    client, screener_service, u_service, mock_provider, universe_file, test_clock = screener_app_and_client

    # 1. Unauthenticated request -> HTTP 401
    unauth_res = client.get("/api/v1/market-data/universe/largecap/screen")
    assert unauth_res.status_code == 401

    # 2. Authenticate
    authenticate(client, "screener_tester@example.com")

    # 3. Universe missing -> HTTP 503 with X-Universe-Status header
    if universe_file.exists():
        universe_file.unlink()
    u_service._cached_universe = None

    res_missing = client.get("/api/v1/market-data/universe/largecap/screen")
    assert res_missing.status_code == 503
    assert res_missing.headers.get("X-Universe-Status") == "UNAVAILABLE"

    # 4. Valid universe -> HTTP 200 with camelCase fields
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, universe_file)

    res_valid = client.get("/api/v1/market-data/universe/largecap/screen")
    assert res_valid.status_code == 200
    data = res_valid.json()
    assert "universeVersion" in data
    assert "classificationPeriod" in data
    assert "evaluatedAt" in data
    assert data["totalConstituents"] == 100
    assert isinstance(data["results"], list)
    assert len(data["results"]) == 100

    first = data["results"][0]
    assert first["rank"] == 1
    assert first["canonicalNseSymbol"] == "SYNTH1"
    assert "twentyWeekSma" in first
    assert "weeklyRsi" in first
    assert "isQualified" in first
    assert "diagnosticStatus" in first

    # 5. Qualified only filter -> HTTP 200
    res_qual = client.get("/api/v1/market-data/universe/largecap/screen?qualified_only=true")
    assert res_qual.status_code == 200
    qual_data = res_qual.json()
    assert qual_data["totalConstituents"] == 100
    assert len(qual_data["results"]) == qual_data["qualifiedCount"]

    # 6. Expired universe -> HTTP 422
    test_clock[0] = datetime(2027, 2, 1, 12, 0, tzinfo=timezone.utc)
    res_expired = client.get("/api/v1/market-data/universe/largecap/screen")
    assert res_expired.status_code == 422
    assert res_expired.headers.get("X-Universe-Status") == "EXPIRED"


# =========================================================================
# Scenario 14: Correct reuse of the existing indicator engine
# =========================================================================
@pytest.mark.anyio
async def test_indicator_engine_values_match_screener_output(tmp_path):
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: date(2026, 8, 15))
    provider = MockScreenerProvider()

    candles = make_weekly_candles("SYNTH1", count=60, trend="up")
    provider.candles["SYNTH1"] = candles

    expected_sma = calculate_twenty_week_sma(candles)
    expected_rsi = calculate_wilders_rsi(candles)

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: datetime(2026, 8, 15, 12, 0, tzinfo=timezone.utc),
    )

    response = await screener.screen_universe(as_of_date=date(2026, 8, 15))
    r1 = response.results[0]

    assert r1.twenty_week_sma == float(expected_sma)
    assert r1.weekly_rsi == float(expected_rsi)


# =========================================================================
# Scenario 15: No database changes or test data written to database
# =========================================================================
def test_no_database_records_created_during_screening(screener_app_and_client):
    client, screener_service, u_service, mock_provider, universe_file, settings = screener_app_and_client
    authenticate(client, "db_check_user@example.com")

    universe = generate_synthetic_universe()
    save_universe_artifact(universe, universe_file)

    # Perform screen
    res = client.get("/api/v1/market-data/universe/largecap/screen")
    assert res.status_code == 200

    # Verify positions table remains empty
    pos_res = client.get("/api/v1/portfolio/positions")
    assert pos_res.status_code == 200
    assert len(pos_res.json()["positions"]) == 0


# =========================================================================
# Scenario 16: Screener cache freshness and provider source regression tests
# =========================================================================
@pytest.mark.anyio
async def test_tejhq_eod_quote_freshness_during_market_hours_initial_and_cached(tmp_path):
    """Regression test: A valid TejHQ EOD quote from the latest completed trading day
    must not become stale during market hours on cache hits, even though it is older than 30 seconds.
    Stocks with RSI > 60 must stay QUALIFIED; stocks with RSI <= 60 must stay NOT_QUALIFIED.
    """
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # Thursday 2026-08-13 at 11:00 IST (05:30 UTC) - during NSE market hours
    # Latest completed trading day is Wednesday 2026-08-12
    clock_dt = [datetime(2026, 8, 13, 5, 30, tzinfo=timezone.utc)]

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: clock_dt[0].date())
    provider = MockScreenerProvider(clock=lambda: clock_dt[0])

    # Wednesday session close at 15:30 IST
    wed_close_dt = datetime(2026, 8, 12, 15, 30, tzinfo=IST)

    # SYNTH1: RSI > 70 (trend="up"), quote from Wednesday EOD with source="TEJHQ"
    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=60, trend="up")
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("2500.00"),
        timestamp=wed_close_dt,
        source="TEJHQ",
        is_stale=False,
    )

    # SYNTH2: RSI < 40 (trend="down"), quote from Wednesday EOD with source="TEJHQ"
    provider.candles["SYNTH2"] = make_weekly_candles("SYNTH2", count=60, trend="down")
    provider.quotes["SYNTH2"] = MarketQuote(
        symbol="SYNTH2",
        instrument_identifier="NSE_EQ|INESYNTH2",
        last_price=Decimal("1200.00"),
        timestamp=wed_close_dt,
        source="TEJHQ",
        is_stale=False,
    )

    orig_batch = provider.get_reference_quotes_batch

    async def batch_tejhq(symbols: list[str]) -> dict[str, MarketQuote]:
        quotes = await orig_batch(symbols)
        return {
            s: MarketQuote(
                symbol=s,
                instrument_identifier=f"NSE_EQ|INE{s}",
                last_price=Decimal("2000.00"),
                timestamp=wed_close_dt,
                source="TEJHQ",
                is_stale=False,
            )
            if s not in provider.quotes
            else provider.quotes[s]
            for s in symbols
        }

    provider.get_reference_quotes_batch = batch_tejhq

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_dt[0],
    )

    # 1. Initial screen
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    assert res1.total_constituents == 100
    r1 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH1")
    r2 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH2")

    assert r1.is_stale is False
    assert r1.is_qualified is True
    assert r1.diagnostic_status == "QUALIFIED"

    assert r2.is_stale is False
    assert r2.is_qualified is False
    assert r2.diagnostic_status == "NOT_QUALIFIED"
    assert "Weekly RSI" in (r2.diagnostic_reason or "")

    # Verify provider was called once for batch quotes
    assert provider.batch_quote_calls == 1

    # 2. Cached screen: Advance clock by 60 seconds (still within market hours, quote is ~19.5 hours old)
    clock_dt[0] = clock_dt[0] + timedelta(seconds=60)
    res2 = await screener.screen_universe(as_of_date=date(2026, 8, 13))

    # Verify batch quotes was NOT called again (cache hit)
    assert provider.batch_quote_calls == 1

    r1_cached = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH1")
    r2_cached = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH2")

    # MUST NOT be marked stale! Must preserve qualification
    assert r1_cached.is_stale is False
    assert r1_cached.is_qualified is True
    assert r1_cached.diagnostic_status == "QUALIFIED"

    # Stock with RSI <= 60 must stay NOT_QUALIFIED, NOT overwritten to STALE_QUOTE
    assert r2_cached.is_stale is False
    assert r2_cached.is_qualified is False
    assert r2_cached.diagnostic_status == "NOT_QUALIFIED"
    assert res2.qualified_count == res1.qualified_count


@pytest.mark.anyio
async def test_tejhq_eod_quote_from_older_or_invalid_session_rejected(tmp_path):
    """TejHQ quote from an older session or expiring session date must be rejected
    according to calendar rules in both initial evaluation and cached-result re-evaluation.
    """
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # Thursday 2026-08-13 11:00 IST (05:30 UTC) - during market hours
    # Latest completed trading day is Wednesday 2026-08-12
    clock_dt = [datetime(2026, 8, 13, 5, 30, tzinfo=timezone.utc)]

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: clock_dt[0].date())
    provider = MockScreenerProvider(clock=lambda: clock_dt[0])

    # Case A: Quote is from Tuesday 2026-08-11 (older than latest completed trading day 2026-08-12)
    tue_close_dt = datetime(2026, 8, 11, 15, 30, tzinfo=IST)
    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=60, trend="up")
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("2500.00"),
        timestamp=tue_close_dt,
        source="TEJHQ",
        is_stale=False,
    )

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_dt[0],
    )

    # Initial evaluation: Tuesday quote is stale
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1.is_stale is True
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "STALE_QUOTE"

    # Cached-result re-evaluation: Remains stale
    clock_dt[0] = clock_dt[0] + timedelta(seconds=30)
    res2 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1_c = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1_c.is_stale is True
    assert r1_c.is_qualified is False
    assert r1_c.diagnostic_status == "STALE_QUOTE"

    # Case B: Session expiry during cache lifetime
    # Re-setup with Wednesday quote evaluated at 15:20 IST (session not yet closed)
    clock_dt[0] = datetime(2026, 8, 13, 15, 20, tzinfo=IST).astimezone(timezone.utc)
    wed_close_dt = datetime(2026, 8, 12, 15, 30, tzinfo=IST)
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("2500.00"),
        timestamp=wed_close_dt,
        source="TEJHQ",
        is_stale=False,
    )

    screener_b = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_dt[0],
    )

    # At 15:20 IST, latest completed day is Aug 12 -> Wednesday quote is fresh
    res_b1 = await screener_b.screen_universe(as_of_date=date(2026, 8, 13))
    r1_b1 = next(r for r in res_b1.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1_b1.is_stale is False
    assert r1_b1.is_qualified is True

    # Advance clock to 15:35 IST (Thursday trading session has now completed)
    # Latest completed trading day becomes Aug 13!
    # Cache hit re-evaluation must detect that Wednesday quote has expired!
    clock_dt[0] = datetime(2026, 8, 13, 15, 35, tzinfo=IST).astimezone(timezone.utc)
    res_b2 = await screener_b.screen_universe(as_of_date=date(2026, 8, 13))
    r1_b2 = next(r for r in res_b2.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1_b2.is_stale is True
    assert r1_b2.is_qualified is False
    assert r1_b2.diagnostic_status == "STALE_QUOTE"


@pytest.mark.anyio
async def test_upstox_live_quotes_enforce_market_hours_ttl_initial_and_cached(tmp_path):
    """Upstox live quotes must strictly enforce the 30-second market-hours TTL
    in both initial evaluation and cached-result re-evaluation.
    """
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    # Thursday 2026-08-13 11:00:00 IST (05:30:00 UTC)
    t0 = datetime(2026, 8, 13, 5, 30, 0, tzinfo=timezone.utc)
    clock_dt = [t0]

    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: clock_dt[0].date())
    provider = MockScreenerProvider(clock=lambda: clock_dt[0])

    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=60, trend="up")
    # Quote timestamp is t0 (0 seconds old)
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("1500.00"),
        timestamp=t0,
        source="UPSTOX",
        is_stale=False,
    )

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_dt[0],
    )

    # 1. Initial screen at t0: fresh (< 30s) -> QUALIFIED
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1.is_stale is False
    assert r1.is_qualified is True
    assert r1.diagnostic_status == "QUALIFIED"

    # 2. Cache hit at t0 + 15s (15s elapsed, <= 30s TTL): remains QUALIFIED
    clock_dt[0] = t0 + timedelta(seconds=15)
    res2 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1_c1 = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1_c1.is_stale is False
    assert r1_c1.is_qualified is True

    # 3. Cache hit at t0 + 45s (45s elapsed, > 30s TTL): must expire and become STALE_QUOTE
    clock_dt[0] = t0 + timedelta(seconds=45)
    res3 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1_c2 = next(r for r in res3.results if r.canonical_nse_symbol == "SYNTH1")
    assert r1_c2.is_stale is True
    assert r1_c2.is_qualified is False
    assert r1_c2.diagnostic_status == "STALE_QUOTE"
    assert "Market quote has expired and is stale" in (r1_c2.diagnostic_reason or "")


@pytest.mark.anyio
async def test_missing_timestamp_and_stale_flags_fail_safely(tmp_path):
    """Missing quote or provider-flagged stale quote fails safely in both
    initial evaluation and cached-result re-evaluation.
    """
    artifact_path = tmp_path / "universe.json"
    universe = generate_synthetic_universe()
    save_universe_artifact(universe, artifact_path)

    clock_dt = [datetime(2026, 8, 13, 5, 30, tzinfo=timezone.utc)]
    u_service = UniverseService(artifact_path=artifact_path, clock=lambda: clock_dt[0].date())
    provider = MockScreenerProvider(clock=lambda: clock_dt[0])

    provider.candles["SYNTH1"] = make_weekly_candles("SYNTH1", count=60, trend="up")
    provider.candles["SYNTH2"] = make_weekly_candles("SYNTH2", count=60, trend="up")

    # SYNTH1: provider explicitly flags is_stale=True
    provider.quotes["SYNTH1"] = MarketQuote(
        symbol="SYNTH1",
        instrument_identifier="NSE_EQ|INESYNTH1",
        last_price=Decimal("1500.00"),
        timestamp=clock_dt[0],
        source="UPSTOX",
        is_stale=True,
    )

    orig_batch = provider.get_reference_quotes_batch

    async def batch_with_missing(symbols: list[str]) -> dict[str, MarketQuote]:
        res = await orig_batch(symbols)
        res.pop("SYNTH2", None)
        return res

    provider.get_reference_quotes_batch = batch_with_missing

    screener = UniverseScreenerService(
        universe_service=u_service,
        provider=provider,
        clock=lambda: clock_dt[0],
    )

    # Initial evaluation
    res1 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH1")
    r2 = next(r for r in res1.results if r.canonical_nse_symbol == "SYNTH2")

    assert r1.is_stale is True
    assert r1.is_qualified is False
    assert r1.diagnostic_status == "STALE_QUOTE"

    assert r2.is_qualified is False
    assert r2.diagnostic_status == "QUOTE_UNAVAILABLE"

    # Cached-result re-evaluation: stays failed safely
    clock_dt[0] = clock_dt[0] + timedelta(seconds=10)
    res2 = await screener.screen_universe(as_of_date=date(2026, 8, 13))
    r1_c = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH1")
    r2_c = next(r for r in res2.results if r.canonical_nse_symbol == "SYNTH2")

    assert r1_c.is_stale is True
    assert r1_c.is_qualified is False
    assert r1_c.diagnostic_status == "STALE_QUOTE"

    assert r2_c.is_qualified is False
    assert r2_c.diagnostic_status == "QUOTE_UNAVAILABLE"
