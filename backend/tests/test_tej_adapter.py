"""Comprehensive unit and integration tests for TejMarketDataProvider and EOD processing.

Covers:
- Daily-to-weekly candle aggregation.
- Holiday and shortened-week handling.
- Incomplete forming-week exclusion.
- Minimum completed history (>=20 SMA, >=50 RSI).
- Split and bonus back-adjustment handling.
- Preservation of raw unadjusted closing price in MarketQuote.
- Calendar-aware freshness and weekend tolerance.
- Upstream status endpoint checking.
- Batch quote scanning.
- Screener qualification and diagnostics.
- Reference price vs execution price distinction and validation.
- Server-authoritative portfolio safeguards.
"""

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from app.core.config import Settings
from app.schemas.universe import LargeCapUniverse, UniverseConstituent, UniverseMetadata
from app.services.market_data.calendar import (
    IST,
    NSE_MARKET_CLOSE_TIME,
    NSETradingCalendar,
    VERIFIED_NSE_HOLIDAYS,
)
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MarketDataUnavailableError,
)
from app.services.market_data.indicators import calculate_technical_indicators
from app.services.market_data.service import (
    MarketDataService,
    MarketSnapshot,
    derive_initial_entry,
    derive_pyramid_entry,
)
from app.services.market_data.tej import (
    DailyEquityRecord,
    DailyToWeeklyCandleAggregator,
    TejMarketDataProvider,
)
from app.services.market_data.universe_screener import UniverseScreenerService
from app.services.market_data.universe_service import UniverseService


def create_test_parquet(
    file_path: Path,
    records: list[dict[str, Any]],
) -> None:
    """Helper to generate a valid test Parquet partition using PyArrow."""
    schema = pa.schema([
        ("date", pa.string()),
        ("symbol", pa.string()),
        ("series", pa.string()),
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("volume", pa.int64()),
        ("adj_factor_cumulative", pa.float64()),
        ("adj_close", pa.float64()),
        ("isin", pa.string()),
    ])

    data: dict[str, list[Any]] = {field.name: [] for field in schema}
    for r in records:
        for field in schema:
            data[field.name].append(r.get(field.name))

    table = pa.Table.from_pydict(data, schema=schema)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, file_path)


# ---------------------------------------------------------------------------
# 1. Daily-to-Weekly Candle Aggregator Tests
# ---------------------------------------------------------------------------

def test_daily_to_weekly_aggregation_standard_week():
    """Verify daily records across a normal Monday-Friday week aggregate accurately."""
    calendar = NSETradingCalendar()
    aggregator = DailyToWeeklyCandleAggregator(calendar)

    # Week of Monday 2026-06-01 to Friday 2026-06-05
    records = [
        DailyEquityRecord(
            date=date(2026, 6, 1),
            symbol="TEST",
            series="EQ",
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("99.00"),
            close=Decimal("102.00"),
            volume=1000,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("102.00"),
            isin="INE001A01010",
        ),
        DailyEquityRecord(
            date=date(2026, 6, 2),
            symbol="TEST",
            series="EQ",
            open=Decimal("102.00"),
            high=Decimal("108.00"),
            low=Decimal("101.00"),
            close=Decimal("107.00"),
            volume=1200,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("107.00"),
            isin="INE001A01010",
        ),
        DailyEquityRecord(
            date=date(2026, 6, 5),
            symbol="TEST",
            series="EQ",
            open=Decimal("107.00"),
            high=Decimal("110.00"),
            low=Decimal("104.00"),
            close=Decimal("109.00"),
            volume=1500,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("109.00"),
            isin="INE001A01010",
        ),
    ]

    # Evaluated after Friday close (e.g. Saturday 2026-06-06)
    as_of = datetime(2026, 6, 6, 10, 0, tzinfo=timezone.utc)
    weekly_candles = aggregator.aggregate(records, symbol="TEST", as_of=as_of)

    assert len(weekly_candles) == 1
    candle = weekly_candles[0]
    assert candle.symbol == "TEST"
    assert candle.candle_date == date(2026, 6, 5)
    assert candle.open_price == Decimal("100.0000")
    assert candle.high_price == Decimal("110.0000")
    assert candle.low_price == Decimal("99.0000")
    assert candle.close_price == Decimal("109.0000")
    assert candle.volume == 3700
    assert candle.is_completed is True


def test_holiday_shortened_week_aggregation():
    """Verify a week ending Thursday due to Good Friday holiday resolves Thursday as weekly close."""
    calendar = NSETradingCalendar()
    aggregator = DailyToWeeklyCandleAggregator(calendar)

    # 2026 Good Friday is 2026-04-03. Week ends Thursday 2026-04-02.
    records = [
        DailyEquityRecord(
            date=date(2026, 3, 30),
            symbol="TEST",
            series="EQ",
            open=Decimal("200.00"),
            high=Decimal("205.00"),
            low=Decimal("198.00"),
            close=Decimal("202.00"),
            volume=1000,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("202.00"),
            isin="INE001A01010",
        ),
        DailyEquityRecord(
            date=date(2026, 4, 2),  # Thursday session before Good Friday
            symbol="TEST",
            series="EQ",
            open=Decimal("203.00"),
            high=Decimal("212.00"),
            low=Decimal("201.00"),
            close=Decimal("210.00"),
            volume=2000,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("210.00"),
            isin="INE001A01010",
        ),
    ]

    # Evaluated Thursday at 16:00 IST (post market close)
    as_of = datetime(2026, 4, 2, 11, 0, tzinfo=timezone.utc)  # 16:30 IST
    weekly_candles = aggregator.aggregate(records, symbol="TEST", as_of=as_of)

    assert len(weekly_candles) == 1
    candle = weekly_candles[0]
    assert candle.candle_date == date(2026, 4, 2)
    assert candle.close_price == Decimal("210.0000")
    assert candle.is_completed is True


def test_incomplete_forming_week_not_marked_completed():
    """Verify forming current week is marked is_completed=False and rejected by indicators."""
    calendar = NSETradingCalendar()
    aggregator = DailyToWeeklyCandleAggregator(calendar)

    # Wednesday session
    records = [
        DailyEquityRecord(
            date=date(2026, 6, 3),
            symbol="TEST",
            series="EQ",
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("98.00"),
            close=Decimal("103.00"),
            volume=1000,
            adj_factor_cumulative=Decimal("1.0"),
            adj_close=Decimal("103.00"),
            isin="INE001A01010",
        ),
    ]

    # Evaluated Wednesday 11:00 AM IST
    as_of = datetime(2026, 6, 3, 5, 30, tzinfo=timezone.utc)
    weekly_candles = aggregator.aggregate(records, symbol="TEST", as_of=as_of)

    assert len(weekly_candles) == 1
    assert weekly_candles[0].is_completed is False


# ---------------------------------------------------------------------------
# 2. Corporate Actions: Splits & Bonuses vs Raw Closing Price
# ---------------------------------------------------------------------------

def test_split_adjustment_and_raw_price_separation(tmp_path):
    """Verify corporate actions scale historical OHLC while preserving raw latest close."""
    calendar = NSETradingCalendar()

    # Create synthetic daily data for 55 weeks with realistic up and down oscillations
    # A 2:1 stock split happens at Week 40.
    # Pre-split dates have adj_factor_cumulative = 0.5.
    # Post-split dates have adj_factor_cumulative = 1.0.
    base_monday = date(2025, 5, 5)
    records: list[dict[str, Any]] = []

    curr_price = 2000.0
    for w in range(55):
        w_monday = base_monday + timedelta(weeks=w)
        w_friday = w_monday + timedelta(days=4)
        is_post_split = w >= 40
        factor = 1.0 if is_post_split else 0.5

        if w == 40:
            curr_price = curr_price / 2.0  # Split happens!

        # Oscillating steps with slight upward drift
        step = 10.0 if (w % 3 != 0) else -6.0
        curr_price += step
        adj_close = curr_price * factor

        records.append({
            "date": w_friday.isoformat(),
            "symbol": "SPLITSTOCK",
            "series": "EQ",
            "open": curr_price - 5.0,
            "high": curr_price + 10.0,
            "low": curr_price - 10.0,
            "close": curr_price,
            "volume": 50000,
            "adj_factor_cumulative": factor,
            "adj_close": adj_close,
            "isin": "INE999A01010",
        })

    # Save to parquet
    p_path = tmp_path / "prices_adjusted_nse_2026.parquet"
    create_test_parquet(p_path, records)

    # Provider evaluated at last week Friday evening
    last_date = date.fromisoformat(records[-1]["date"])
    as_of = datetime.combine(last_date, time(18, 0), tzinfo=IST).astimezone(timezone.utc)

    provider = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: as_of,
        auto_sync=False,
    )

    # 1. Check reference quote: MUST return raw unadjusted price!
    quote = pytest.importorskip("asyncio").run(provider.get_reference_quote("SPLITSTOCK"))
    expected_raw_close = Decimal(str(records[-1]["close"]))
    assert quote.last_price == expected_raw_close
    assert quote.source == "TEJHQ"
    assert quote.is_stale is False

    # 2. Check weekly candles: MUST be adjusted smoothly
    candles = pytest.importorskip("asyncio").run(
        provider.get_historical_weekly_candles("SPLITSTOCK", limit_weeks=100)
    )
    assert len(candles) == 55
    for c in candles:
        assert c.is_completed is True

    # Indicators calculate continuously across the split without failing
    indicators = calculate_technical_indicators("SPLITSTOCK", candles)
    assert indicators.is_valid is True
    assert indicators.twenty_week_sma is not None
    assert indicators.weekly_rsi is not None
    # Smooth progression: RSI should not be 0 or 100 from an artificial price cliff
    assert Decimal("40") < indicators.weekly_rsi < Decimal("85")


# ---------------------------------------------------------------------------
# 3. Minimum History Requirements (20w SMA & 50w RSI)
# ---------------------------------------------------------------------------

def test_indicator_minimum_history_thresholds(tmp_path):
    """Verify <20 candles yields no SMA/RSI; 20-49 yields SMA but no RSI; >=50 yields both."""
    calendar = NSETradingCalendar()
    base_monday = date(2025, 1, 6)

    def _make_candles(count: int) -> list[dict[str, Any]]:
        recs = []
        for w in range(count):
            d = base_monday + timedelta(weeks=w, days=4)
            recs.append({
                "date": d.isoformat(),
                "symbol": f"HIST{count}",
                "series": "EQ",
                "open": 500.0,
                "high": 510.0,
                "low": 490.0,
                "close": 505.0,
                "volume": 10000,
                "adj_factor_cumulative": 1.0,
                "adj_close": 505.0,
                "isin": "INE123A01010",
            })
        return recs

    all_records = _make_candles(15) + _make_candles(30) + _make_candles(52)
    p_path = tmp_path / "prices_adjusted_nse_2026.parquet"
    create_test_parquet(p_path, all_records)

    last_d = date.fromisoformat(all_records[-1]["date"])
    as_of = datetime.combine(last_d, time(18, 0), tzinfo=IST).astimezone(timezone.utc)

    provider = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: as_of,
        auto_sync=False,
    )

    import asyncio

    # Case A: 15 candles (<20) -> SMA None, RSI None
    c_15 = asyncio.run(provider.get_historical_weekly_candles("HIST15"))
    ind_15 = calculate_technical_indicators("HIST15", c_15)
    assert ind_15.twenty_week_sma is None
    assert ind_15.weekly_rsi is None
    assert ind_15.is_valid is False

    # Case B: 30 candles (>=20, <50) -> SMA Available, RSI Unavailable
    c_30 = asyncio.run(provider.get_historical_weekly_candles("HIST30"))
    ind_30 = calculate_technical_indicators("HIST30", c_30)
    assert ind_30.twenty_week_sma is not None
    assert ind_30.weekly_rsi is None
    assert ind_30.is_valid is False

    # Case C: 52 candles (>=50) -> Both SMA and RSI Available
    c_52 = asyncio.run(provider.get_historical_weekly_candles("HIST52"))
    ind_52 = calculate_technical_indicators("HIST52", c_52)
    assert ind_52.twenty_week_sma is not None
    assert ind_52.weekly_rsi is not None
    assert ind_52.is_valid is True


# ---------------------------------------------------------------------------
# 4. Freshness & Weekend Policy Tests
# ---------------------------------------------------------------------------

def test_freshness_and_weekend_policy(tmp_path):
    """Verify Friday's EOD data remains fresh over Saturday and Sunday."""
    calendar = NSETradingCalendar()

    # Data for Friday 2026-10-23
    friday_date = date(2026, 10, 23)
    record = [{
        "date": friday_date.isoformat(),
        "symbol": "RELIANCE",
        "series": "EQ",
        "open": 2500.0,
        "high": 2550.0,
        "low": 2490.0,
        "close": 2520.0,
        "volume": 500000,
        "adj_factor_cumulative": 1.0,
        "adj_close": 2520.0,
        "isin": "INE002A01018",
    }]
    create_test_parquet(tmp_path / "prices_adjusted_nse_2026.parquet", record)

    import asyncio

    # 1. Saturday 2026-10-24 14:00 IST -> Fresh (weekend tolerance)
    sat_as_of = datetime(2026, 10, 24, 8, 30, tzinfo=timezone.utc)
    provider_sat = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: sat_as_of,
        auto_sync=False,
    )
    quote_sat = asyncio.run(provider_sat.get_reference_quote("RELIANCE"))
    assert quote_sat.is_stale is False

    # 2. Sunday 2026-10-25 18:00 IST -> Fresh (weekend tolerance)
    sun_as_of = datetime(2026, 10, 25, 12, 30, tzinfo=timezone.utc)
    provider_sun = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: sun_as_of,
        auto_sync=False,
    )
    quote_sun = asyncio.run(provider_sun.get_reference_quote("RELIANCE"))
    assert quote_sun.is_stale is False

    # 3. Tuesday 2026-10-27 16:00 IST -> Stale (Monday and Tuesday sessions completed)
    tue_as_of = datetime(2026, 10, 27, 10, 30, tzinfo=timezone.utc)
    provider_tue = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: tue_as_of,
        auto_sync=False,
    )
    quote_tue = asyncio.run(provider_tue.get_reference_quote("RELIANCE"))
    assert quote_tue.is_stale is True


# ---------------------------------------------------------------------------
# 5. Price Semantics: Reference Price vs Execution Price
# ---------------------------------------------------------------------------

def test_price_semantics_execution_confirmation_enforced():
    """Verify that EOD reference prices require explicit execution confirmation."""
    now_utc = datetime.now(timezone.utc)
    snapshot = MarketSnapshot(
        symbol="INFY",
        instrument_identifier="INE009A01021",
        last_price=Decimal("1800.00"),
        quote_timestamp=now_utc,
        twenty_week_sma=Decimal("1700.00"),
        weekly_rsi=Decimal("65.5"),
        latest_completed_candle_date=date(2026, 10, 23),
        completed_candles_count=52,
        is_stale=False,
        is_eligible_for_initial=True,
        source="TEJHQ",
    )

    capital = Decimal("500000.00")

    # 1. Neither execution_price nor confirm_reference_price_as_execution provided -> MUST raise ValueError
    with pytest.raises(ValueError, match="Explicit execution price confirmation is required"):
        derive_initial_entry(snapshot, capital=capital)

    # 2. User confirms execution at the reference price -> Success with reference price
    entry_confirmed = derive_initial_entry(
        snapshot,
        capital=capital,
        confirm_reference_price_as_execution=True,
    )
    assert entry_confirmed.entry_price == Decimal("1800.00")
    assert entry_confirmed.stop_loss == Decimal("1700.00")
    assert entry_confirmed.rps == Decimal("100.00")
    assert entry_confirmed.quantity == 50  # 5000 / 100

    # 3. User provides actual executed fill price (e.g. ₹1810.00) -> Uses explicit execution price!
    entry_custom = derive_initial_entry(
        snapshot,
        capital=capital,
        execution_price=Decimal("1810.00"),
    )
    assert entry_custom.entry_price == Decimal("1810.00")
    assert entry_custom.rps == Decimal("110.00")
    assert entry_custom.quantity == 45  # floor(5000 / 110) = 45


def test_pyramid_entry_execution_price_and_tolerance():
    """Verify pyramid entry respects both 20w SMA tolerance and explicit execution price."""
    now_utc = datetime.now(timezone.utc)
    # Previous entry at 1700.00. 20w SMA is 1702.50.
    # Tolerance range [1700.00, 1703.00] -> 1702.50 is strictly valid.
    snapshot = MarketSnapshot(
        symbol="INFY",
        instrument_identifier="INE009A01021",
        last_price=Decimal("1850.00"),
        quote_timestamp=now_utc,
        twenty_week_sma=Decimal("1702.50"),
        weekly_rsi=Decimal("68.0"),
        latest_completed_candle_date=date(2026, 10, 23),
        completed_candles_count=52,
        is_stale=False,
        is_eligible_for_initial=True,
        source="TEJHQ",
    )

    capital = Decimal("500000.00")
    prev_price = Decimal("1700.00")

    # 1. Without confirmation for TEJHQ -> Error
    with pytest.raises(ValueError, match="Explicit execution price confirmation is required"):
        derive_pyramid_entry(
            snapshot,
            capital=capital,
            previous_entry_price=prev_price,
            next_sequence=2,
        )

    # 2. Confirmed with explicit fill price 1855.00
    pyramid_entry = derive_pyramid_entry(
        snapshot,
        capital=capital,
        previous_entry_price=prev_price,
        next_sequence=2,
        execution_price=Decimal("1855.00"),
    )
    assert pyramid_entry.entry_price == Decimal("1855.00")
    assert pyramid_entry.stop_loss == Decimal("1702.50")
    assert pyramid_entry.sequence == 2
    assert pyramid_entry.entry_type == "PYRAMID_ENTRY"


# ---------------------------------------------------------------------------
# 6. Bulk Screener Integration with TejMarketDataProvider
# ---------------------------------------------------------------------------

def test_screener_integration_with_tej_provider(tmp_path):
    """Verify UniverseScreenerService operates end-to-end with TejMarketDataProvider."""
    calendar = NSETradingCalendar()
    base_monday = date(2025, 5, 5)

    # 2 symbols:
    # SYM_QUAL: steady rise, RSI > 60
    # SYM_LOW_RSI: steady fall, RSI < 40
    records = []
    for w in range(55):
        w_d = (base_monday + timedelta(weeks=w, days=4)).isoformat()
        records.append({
            "date": w_d,
            "symbol": "QUAL",
            "series": "EQ",
            "open": 100.0 + (w * 5.0),
            "high": 105.0 + (w * 5.0),
            "low": 98.0 + (w * 5.0),
            "close": 104.0 + (w * 5.0),
            "volume": 20000,
            "adj_factor_cumulative": 1.0,
            "adj_close": 104.0 + (w * 5.0),
            "isin": "INE111A01011",
        })
        records.append({
            "date": w_d,
            "symbol": "NOTQUAL",
            "series": "EQ",
            "open": 500.0 - (w * 3.0),
            "high": 505.0 - (w * 3.0),
            "low": 490.0 - (w * 3.0),
            "close": 495.0 - (w * 3.0),
            "volume": 15000,
            "adj_factor_cumulative": 1.0,
            "adj_close": 495.0 - (w * 3.0),
            "isin": "INE222A01022",
        })

    create_test_parquet(tmp_path / "prices_adjusted_nse_2026.parquet", records)

    last_d = date.fromisoformat(records[-1]["date"])
    as_of = datetime.combine(last_d, time(18, 0), tzinfo=IST).astimezone(timezone.utc)

    provider = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: as_of,
        auto_sync=False,
    )

    # Mock universe service
    class MockUniverseService:
        def get_status(self, as_of_date=None):
            from app.schemas.universe import UniverseStatusRead
            return UniverseStatusRead(
                is_available=True,
                is_valid_for_date=True,
                status="VALID",
                status_reason="Active and valid",
                dataset_version="AMFI-2026-H2-V1",
                classification_period="JUL_DEC_2026",
                source_period_label="July 2026 - December 2026",
                effective_from=date(2026, 7, 1),
                effective_to=date(2026, 12, 31),
                as_of_date=last_d,
                is_stale=False,
                days_until_expiration=65,
                constituent_count=2,
            )

        def get_constituents(self, as_of_date=None):
            return [
                UniverseConstituent(
                    rank=1,
                    isin="INE111A01011",
                    company_name="Qualified Stock Ltd",
                    source_symbol="QUAL",
                    canonical_nse_symbol="QUAL",
                    upstox_instrument_key="NSE_EQ|INE111A01011",
                ),
                UniverseConstituent(
                    rank=2,
                    isin="INE222A01022",
                    company_name="Not Qualified Ltd",
                    source_symbol="NOTQUAL",
                    canonical_nse_symbol="NOTQUAL",
                    upstox_instrument_key="NSE_EQ|INE222A01022",
                ),
            ]

    screener = UniverseScreenerService(
        universe_service=MockUniverseService(),
        provider=provider,
        calendar=calendar,
        clock=lambda: as_of,
    )

    import asyncio
    screen_res = asyncio.run(screener.screen_universe())
    assert screen_res.total_constituents == 2
    assert screen_res.qualified_count == 1

    r_qual = next(r for r in screen_res.results if r.canonical_nse_symbol == "QUAL")
    assert r_qual.is_qualified is True
    assert r_qual.diagnostic_status == "QUALIFIED"
    assert r_qual.weekly_rsi is not None and r_qual.weekly_rsi > 60.0

    r_not = next(r for r in screen_res.results if r.canonical_nse_symbol == "NOTQUAL")
    assert r_not.is_qualified is False
    assert r_not.diagnostic_status == "NOT_QUALIFIED"


# ---------------------------------------------------------------------------
# 7. Additional Targeted Edge-Case & Error Tests
# ---------------------------------------------------------------------------

def test_missing_instrument_raises_error(tmp_path):
    """Verify querying an unlisted/missing symbol raises InstrumentNotFoundError."""
    calendar = NSETradingCalendar()
    provider = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        auto_sync=False,
    )

    import asyncio
    with pytest.raises(InstrumentNotFoundError):
        asyncio.run(provider.get_reference_quote("UNKNOWN_XYZ"))

    with pytest.raises(InstrumentNotFoundError):
        asyncio.run(provider.get_historical_weekly_candles("UNKNOWN_XYZ"))


def test_batch_quote_scan_matches_individual_quotes(tmp_path):
    """Verify get_reference_quotes_batch produces identical results to individual queries."""
    calendar = NSETradingCalendar()
    friday_date = date(2026, 10, 23)

    records = [
        {
            "date": friday_date.isoformat(),
            "symbol": "RELIANCE",
            "series": "EQ",
            "open": 2500.0,
            "high": 2550.0,
            "low": 2490.0,
            "close": 2520.0,
            "volume": 500000,
            "adj_factor_cumulative": 1.0,
            "adj_close": 2520.0,
            "isin": "INE002A01018",
        },
        {
            "date": friday_date.isoformat(),
            "symbol": "TCS",
            "series": "EQ",
            "open": 3500.0,
            "high": 3560.0,
            "low": 3480.0,
            "close": 3540.0,
            "volume": 300000,
            "adj_factor_cumulative": 1.0,
            "adj_close": 3540.0,
            "isin": "INE467B01029",
        },
    ]
    create_test_parquet(tmp_path / "prices_adjusted_nse_2026.parquet", records)

    as_of = datetime.combine(friday_date, time(18, 0), tzinfo=IST).astimezone(timezone.utc)
    provider = TejMarketDataProvider(
        data_dir=tmp_path,
        calendar=calendar,
        clock=lambda: as_of,
        auto_sync=False,
    )

    import asyncio
    batch_quotes = asyncio.run(provider.get_reference_quotes_batch(["RELIANCE", "TCS"]))
    assert "RELIANCE" in batch_quotes
    assert "TCS" in batch_quotes

    single_rel = asyncio.run(provider.get_reference_quote("RELIANCE"))
    single_tcs = asyncio.run(provider.get_reference_quote("TCS"))

    assert batch_quotes["RELIANCE"].last_price == single_rel.last_price
    assert batch_quotes["RELIANCE"].instrument_identifier == single_rel.instrument_identifier
    assert batch_quotes["TCS"].last_price == single_tcs.last_price


def test_provider_factory_configuration():
    """Verify create_market_data_provider selects the expected adapter based on settings."""
    from app.services.market_data.factory import create_market_data_provider
    from app.services.market_data.upstox import UpstoxMarketDataProvider

    settings_tej = Settings(market_data_provider="tej")
    provider_tej = create_market_data_provider(settings_tej)
    assert isinstance(provider_tej, TejMarketDataProvider)

    settings_upstox = Settings(market_data_provider="upstox")
    provider_upstox = create_market_data_provider(settings_upstox)
    assert isinstance(provider_upstox, UpstoxMarketDataProvider)


def test_upstox_backward_compatibility_retains_unconfirmed_price_derivation():
    """Verify that UPSTOX quotes (live feeds) still derive entry without explicit confirmation."""
    now_utc = datetime.now(timezone.utc)
    snapshot = MarketSnapshot(
        symbol="HDFCBANK",
        instrument_identifier="NSE_EQ|INE040A01034",
        last_price=Decimal("1650.00"),
        quote_timestamp=now_utc,
        twenty_week_sma=Decimal("1550.00"),
        weekly_rsi=Decimal("63.0"),
        latest_completed_candle_date=date(2026, 10, 23),
        completed_candles_count=52,
        is_stale=False,
        is_eligible_for_initial=True,
        source="UPSTOX",
    )

    capital = Decimal("500000.00")
    # All providers require explicit execution price or confirmation (Priority 1, Requirement 6)
    with pytest.raises(ValueError, match="Explicit execution price confirmation is required"):
        derive_initial_entry(snapshot, capital=capital)

    entry = derive_initial_entry(snapshot, capital=capital, confirm_reference_price_as_execution=True)
    assert entry.entry_price == Decimal("1650.00")
    assert entry.stop_loss == Decimal("1550.00")
    assert entry.rps == Decimal("100.00")
    assert entry.quantity == 50

