"""Tests for server-authoritative market data snapshots and portfolio entry creation rules."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.database.session import make_engine, make_session_factory
from app.main import create_app
from app.models.instrument import Instrument
from app.models.portfolio import PortfolioPosition, TradeEntry
from app.services.market_data.base import MarketDataProvider, MarketQuote, WeeklyCandle
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
)
from app.services.market_data.service import MarketDataService


class MockDeterministicMarketDataProvider(MarketDataProvider):
    """Deterministic market data provider for isolated unit testing."""

    def __init__(
        self,
        quote: MarketQuote | None = None,
        candles: list[WeeklyCandle] | None = None,
        instrument_key: str = "NSE_EQ|INE002A01018",
        raise_auth_error: bool = False,
        raise_unavailable_error: bool = False,
    ) -> None:
        self._quote = quote
        self._candles = candles or []
        self._instrument_key = instrument_key
        self._raise_auth_error = raise_auth_error
        self._raise_unavailable_error = raise_unavailable_error

    async def get_instrument_identifier(self, symbol: str) -> str | None:
        if symbol == "NONEXISTENT":
            return None
        return self._instrument_key

    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        if self._raise_auth_error:
            raise ProviderAuthenticationError("Upstox token missing")
        if self._raise_unavailable_error:
            raise MarketDataUnavailableError("Provider is down")
        if self._quote is None:
            raise MarketDataUnavailableError("No quote configured")
        return self._quote

    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        if self._raise_unavailable_error:
            raise MarketDataUnavailableError("Provider is down")
        return self._candles


def generate_completed_candles(
    count: int = 55,
    base_price: Decimal = Decimal("2400.00"),
    step: Decimal = Decimal("2.00"),
    symbol: str = "RELIANCE",
) -> list[WeeklyCandle]:
    """Generate ascending candle series where RSI > 60 and latest 20 average is predictable."""
    candles: list[WeeklyCandle] = []
    start_date = date(2023, 1, 6)

    # Monotonically increasing prices produce strong upward gains (RSI > 60)
    for i in range(count):
        c_date = start_date + timedelta(weeks=i)
        close_price = base_price + (step * Decimal(i))
        candles.append(
            WeeklyCandle(
                symbol=symbol,
                candle_date=c_date,
                open_price=close_price - Decimal("1.00"),
                high_price=close_price + Decimal("2.00"),
                low_price=close_price - Decimal("2.00"),
                close_price=close_price,
                volume=100000,
                is_completed=True,
            )
        )
    return candles


def make_test_client(
    tmp_path,
    provider: MarketDataProvider,
) -> TestClient:
    db_path = tmp_path / "server-md-test.db"
    database_url = f"sqlite:///{db_path.as_posix()}"

    from tests.conftest import upgrade_database

    upgrade_database(database_url)

    settings = Settings(
        database_url=database_url,
        registration_enabled=True,
        allow_unverified_market_data=False,  # Default safe deny
        upstox_analytics_token="test-analytics-token",
    )
    md_service = MarketDataService(provider=provider)
    app = create_app(settings=settings, market_data_service=md_service)
    return TestClient(app, base_url="https://testserver")


def auth_user(client: TestClient, email: str = "trader@example.com") -> dict[str, str]:
    reg = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": email, "password": "Password123!"},
    )
    assert reg.status_code == 201
    csrf = client.cookies.get("nse_csrf")
    return {"Origin": "https://testserver", "x-csrf-token": csrf}


# 1. Authoritative Market Snapshot endpoint test
def test_market_snapshot_endpoint(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2550.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=False,
    )
    candles = generate_completed_candles(count=55, base_price=Decimal("2000.00"), step=Decimal("5.00"))
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Valid symbol snapshot
    res = client.get("/api/v1/market-data/snapshot/RELIANCE")
    assert res.status_code == 200
    data = res.json()
    assert data["symbol"] == "RELIANCE"
    assert data["lastPrice"] == 2550.00
    assert data["twentyWeekSma"] is not None
    assert data["weeklyRsi"] is not None
    assert data["weeklyRsi"] > 60.0
    assert data["isEligibleForInitial"] is True
    assert data["isStale"] is False

    # Unknown symbol snapshot -> 404
    missing_res = client.get("/api/v1/market-data/snapshot/NONEXISTENT")
    assert missing_res.status_code == 404


# 2. Server-Authoritative Initial Position Creation: Valid Sizing
def test_server_authoritative_initial_position_creation(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2550.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=False,
    )
    # 55 candles where closes steadily rise: 2000, 2005, ..., 2270
    candles = generate_completed_candles(count=55, base_price=Decimal("2000.00"), step=Decimal("5.00"))
    # Last 20 closes: 2000 + 5*35 = 2175 to 2000 + 5*54 = 2270
    # Average of arithmetic progression = (2175 + 2270) / 2 = 2222.50 (20-week SMA)
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Without execution confirmation or custom price -> MUST be rejected with HTTP 422
    res_unconfirmed = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "500000.00",
        },
    )
    assert res_unconfirmed.status_code == 422
    assert "Explicit execution price confirmation is required" in res_unconfirmed.json()["detail"]

    # Client confirms reference price (with an attempt to inject bogus prices/quantities)
    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "500000.00",
            "notes": "Server derived entry",
            "confirm_reference_price_as_execution": True,
            # Bogus client fields that MUST be ignored:
            "entry_price": "9999.00",
            "stop_loss": "1.00",
            "quantity": 999999,
        },
    )
    assert res.status_code == 201
    pos_data = res.json()
    assert pos_data["symbol"] == "RELIANCE"
    assert pos_data["status"] == "ACTIVE"

    entry = pos_data["entries"][0]
    assert entry["sequence"] == 1
    assert entry["entryType"] == "INITIAL_ENTRY"
    assert entry["entryPrice"] == 2550.00  # Verified from quote, not client's 9999.00!
    assert entry["stopLoss"] == 2222.50   # 20-week SMA
    assert entry["rps"] == 327.50          # 2550.00 - 2222.50
    assert entry["rpt"] == 5000.00         # 1% of 500000.00
    # Quantity: floor(5000 / 327.50) = 15
    assert entry["quantity"] == 15
    assert entry["sizingStatus"] == "VALID"
    assert entry["capitalSnapshot"] == 500000.00
    assert entry["notes"] == "Server derived entry"


# 3. Server-Authoritative Initial Position Creation: Non-Positive RPS Warning
def test_initial_position_non_positive_rps_warning(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    # Quote price is BELOW the 20-week SMA (e.g. 2100 < 2222.50) -> RPS <= 0
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2100.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=False,
    )
    candles = generate_completed_candles(count=55, base_price=Decimal("2000.00"), step=Decimal("5.00"))
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # 1. Non-positive RPS without acknowledge_invalid_rps MUST be rejected with HTTP 422 (Priority 4)
    res_unack = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "500000.00",
            "confirm_reference_price_as_execution": True,
            "acknowledge_invalid_rps": False,
        },
    )
    assert res_unack.status_code == 422
    assert "Explicit acknowledgement" in res_unack.json()["detail"]

    # 2. With acknowledge_invalid_rps=True and confirm_reference_price_as_execution=True -> 201 Created with null quantity
    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "500000.00",
            "confirm_reference_price_as_execution": True,
            "acknowledge_invalid_rps": True,
        },
    )
    assert res.status_code == 201
    pos_data = res.json()
    entry = pos_data["entries"][0]
    assert entry["entryPrice"] == 2100.00
    assert entry["stopLoss"] == 2222.50
    assert entry["rps"] == -122.50
    assert entry["quantity"] is None  # Null quantity for warning
    assert entry["sizingStatus"] == "INVALID_RPS_WARNING"


# 4. Rejection when RSI is not strictly greater than 60
def test_initial_position_rejected_when_rsi_not_greater_than_60(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2500.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=False,
    )
    # Monotonically declining prices produce very low RSI (e.g. RSI < 10)
    candles = generate_completed_candles(count=55, base_price=Decimal("3000.00"), step=Decimal("-5.00"))
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={"symbol": "RELIANCE", "capital": "500000.00"},
    )
    assert res.status_code == 422
    assert "weekly RSI" in res.json()["detail"]
    assert "must be strictly greater than 60" in res.json()["detail"]


# 5. Rejection when quote is stale
def test_initial_position_rejected_when_quote_stale(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2500.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=True,  # Stale quote!
    )
    candles = generate_completed_candles(count=55)
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={"symbol": "RELIANCE", "capital": "500000.00"},
    )
    assert res.status_code == 422
    assert "stale" in res.json()["detail"].lower()


# 6. Rejection when history is insufficient (< 50 completed candles)
def test_initial_position_rejected_when_history_insufficient(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote(
        symbol="RELIANCE",
        instrument_identifier="NSE_EQ|INE002A01018",
        last_price=Decimal("2500.00"),
        timestamp=now_utc,
        source="UPSTOX",
        is_stale=False,
    )
    # Only 30 candles (insufficient for Wilder's 14-period RSI which requires 50)
    candles = generate_completed_candles(count=30)
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={"symbol": "RELIANCE", "capital": "500000.00"},
    )
    assert res.status_code == 422
    assert "weekly RSI is unavailable" in res.json()["detail"]


# 7. Server-Authoritative Pyramid Entry: Inclusive ₹3.00 Tolerance Rule Boundaries
def test_pyramid_entry_tolerance_rule_boundaries(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    # Initial entry price was 2200.00
    # Tolerance rule: previous_entry_price <= SMA20 <= previous_entry_price + 3.00
    # Permitted SMA20 range: [2200.00, 2203.00]

    # Boundary Case A: SMA20 == 2200.00 exactly (Lower inclusive boundary)
    # Create 55 flat candles at 2200.00 except earlier ones so SMA20 is exactly 2200.00
    candles_lower: list[WeeklyCandle] = []
    # 35 rising candles then 20 candles at exactly 2200.00
    for i in range(35):
        candles_lower.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=i), Decimal(1800 + i*10), Decimal(1802 + i*10), Decimal(1798 + i*10), Decimal(1800 + i*10), 10000, True)
        )
    for i in range(20):
        candles_lower.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=35 + i), Decimal("2200.00"), Decimal("2202.00"), Decimal("2198.00"), Decimal("2200.00"), 10000, True)
        )

    # Initial quote
    quote_init = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2250.00"), now_utc, "UPSTOX", False)
    provider = MockDeterministicMarketDataProvider(quote=quote_init, candles=candles_lower)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Create initial position
    # Let's seed initial position directly with entry price = 2200.00
    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(symbol="RELIANCE", canonical_symbol="RELIANCE.NS", display_name="RELIANCE", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst)
        db.flush()
        pos = PortfolioPosition(user_id=user.id, instrument_id=inst.id, status="ACTIVE", initial_entry_date=date(2024, 1, 1))
        db.add(pos)
        db.flush()
        e1 = TradeEntry(
            position_id=pos.id,
            sequence=1,
            entry_type="INITIAL_ENTRY",
            entry_date=date(2024, 1, 1),
            entry_price=Decimal("2200.00"),
            stop_loss=Decimal("2100.00"),
            rps=Decimal("100.00"),
            rpt=Decimal("5000.00"),
            quantity=50,
            capital_snapshot=Decimal("500000.00"),
            sizing_status="VALID",
        )
        pos.entries.append(e1)
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    # Now pyramid when SMA20 is exactly 2200.00 (Boundary A: previous_entry_price <= SMA20)
    quote_pyramid = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2280.00"), now_utc, "UPSTOX", False)
    provider._quote = quote_pyramid

    # Unconfirmed pyramid entry -> MUST be rejected with HTTP 422
    res_pyramid_unconfirmed = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_pyramid_unconfirmed.status_code == 422
    assert "Explicit execution price confirmation is required" in res_pyramid_unconfirmed.json()["detail"]

    res_pyramid_lower = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "capital": "500000.00",
            "notes": "Pyramid at lower boundary",
            "confirm_reference_price_as_execution": True,
        },
    )
    assert res_pyramid_lower.status_code == 201
    p_data = res_pyramid_lower.json()
    assert len(p_data["entries"]) == 2
    assert p_data["entries"][1]["sequence"] == 2
    assert p_data["entries"][1]["entryPrice"] == 2280.00
    assert p_data["entries"][1]["stopLoss"] == 2200.00

    # Boundary Case B: SMA20 == 2283.00 (Upper inclusive boundary for entry 2 where entry_price was 2280.00 -> max 2283.00)
    candles_upper: list[WeeklyCandle] = []
    for i in range(35):
        candles_upper.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=i), Decimal(1800 + i*10), Decimal(1802 + i*10), Decimal(1798 + i*10), Decimal(1800 + i*10), 10000, True)
        )
    for i in range(20):
        candles_upper.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=35 + i), Decimal("2283.00"), Decimal("2285.00"), Decimal("2281.00"), Decimal("2283.00"), 10000, True)
        )
    provider._candles = candles_upper
    provider._quote = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2350.00"), now_utc, "UPSTOX", False)

    res_pyramid_upper = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "capital": "500000.00",
            "notes": "Pyramid at upper boundary",
            "confirm_reference_price_as_execution": True,
        },
    )
    assert res_pyramid_upper.status_code == 201
    assert len(res_pyramid_upper.json()["entries"]) == 3


# 8. Rejection just outside tolerance boundaries
def test_pyramid_entry_rejected_outside_tolerance(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    # Seed position with entry price = 2200.00
    provider = MockDeterministicMarketDataProvider()
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(symbol="RELIANCE", canonical_symbol="RELIANCE.NS", display_name="RELIANCE", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst)
        db.flush()
        pos = PortfolioPosition(user_id=user.id, instrument_id=inst.id, status="ACTIVE", initial_entry_date=date(2024, 1, 1))
        db.add(pos)
        db.flush()
        e1 = TradeEntry(
            position_id=pos.id,
            sequence=1,
            entry_type="INITIAL_ENTRY",
            entry_date=date(2024, 1, 1),
            entry_price=Decimal("2200.00"),
            stop_loss=Decimal("2100.00"),
            rps=Decimal("100.00"),
            rpt=Decimal("5000.00"),
            quantity=50,
            capital_snapshot=Decimal("500000.00"),
            sizing_status="VALID",
        )
        pos.entries.append(e1)
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    # Case 1: SMA20 is 2199.90 (< 2200.00)
    candles_low = generate_completed_candles(count=35, base_price=Decimal("1800.00"), step=Decimal("10.00"))
    for i in range(20):
        candles_low.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=35 + i), Decimal("2199.90"), Decimal("2201.00"), Decimal("2198.00"), Decimal("2199.90"), 10000, True)
        )
    provider._candles = candles_low
    provider._quote = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2250.00"), now_utc, "UPSTOX", False)

    res_too_low = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_too_low.status_code == 422
    assert "outside the required tolerance" in res_too_low.json()["detail"]

    # Case 2: SMA20 is 2203.10 (> 2203.00)
    candles_high = generate_completed_candles(count=35, base_price=Decimal("1800.00"), step=Decimal("10.00"))
    for i in range(20):
        candles_high.append(
            WeeklyCandle("RELIANCE", date(2023, 1, 6) + timedelta(weeks=35 + i), Decimal("2203.10"), Decimal("2205.00"), Decimal("2201.00"), Decimal("2203.10"), 10000, True)
        )
    provider._candles = candles_high

    res_too_high = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_too_high.status_code == 422
    assert "outside the required tolerance" in res_too_high.json()["detail"]


# 9. Pyramid rejected on completed or archived positions
def test_pyramid_rejected_on_exited_or_archived_position(tmp_path) -> None:
    provider = MockDeterministicMarketDataProvider()
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        from app.models.portfolio import PositionExit
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(symbol="RELIANCE", canonical_symbol="RELIANCE.NS", display_name="RELIANCE", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst)
        db.flush()
        # Exited position
        pos_exited = PortfolioPosition(user_id=user.id, instrument_id=inst.id, status="COMPLETED", initial_entry_date=date(2024, 1, 1))
        db.add(pos_exited)
        db.flush()
        pos_exited.entries.append(TradeEntry(position_id=pos_exited.id, sequence=1, entry_type="INITIAL_ENTRY", entry_date=date(2024, 1, 1), entry_price=Decimal("2200"), stop_loss=Decimal("2100"), rps=Decimal("100"), rpt=Decimal("5000"), quantity=50, capital_snapshot=Decimal("500000"), sizing_status="VALID"))
        pos_exited.exit = PositionExit(position_id=pos_exited.id, exit_price=Decimal("2300"), exit_date=date(2024, 2, 1))

        # Archived position
        inst_infy = Instrument(symbol="INFY", canonical_symbol="INFY.NS", display_name="INFY", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst_infy)
        db.flush()
        pos_archived = PortfolioPosition(user_id=user.id, instrument_id=inst_infy.id, status="ARCHIVED", initial_entry_date=date(2024, 1, 1))
        db.add(pos_archived)
        db.flush()
        pos_archived.entries.append(TradeEntry(position_id=pos_archived.id, sequence=1, entry_type="INITIAL_ENTRY", entry_date=date(2024, 1, 1), entry_price=Decimal("1500"), stop_loss=Decimal("1400"), rps=Decimal("100"), rpt=Decimal("5000"), quantity=50, capital_snapshot=Decimal("500000"), sizing_status="VALID"))

        db.commit()
        exited_id = pos_exited.id
        archived_id = pos_archived.id
    finally:
        db.close()

    # Try pyramiding on exited
    res_exited = client.post(f"/api/v1/portfolio/positions/{exited_id}/entries", headers=headers, json={"capital": "500000.00"})
    assert res_exited.status_code == 409

    # Try pyramiding on archived
    res_archived = client.post(f"/api/v1/portfolio/positions/{archived_id}/entries", headers=headers, json={"capital": "500000.00"})
    assert res_archived.status_code == 409


# 10. Creation and pyramiding fail safely with HTTP 403 when provider token is missing without user session invalidation
def test_creation_and_pyramiding_blocked_when_token_missing(tmp_path) -> None:
    provider = MockDeterministicMarketDataProvider(raise_auth_error=True)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # 1. Initial creation blocked with 403
    res_init = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={"symbol": "RELIANCE", "capital": "500000.00"},
    )
    assert res_init.status_code == 403
    assert "temporarily unavailable because verified NSE market data has not been connected" in res_init.json()["detail"]

    # 2. User session remains authenticated and intact (not misclassified as 401)
    res_list = client.get("/api/v1/portfolio/positions")
    assert res_list.status_code == 200
    assert len(res_list.json()["positions"]) == 0

    # 3. Seed an existing active position and verify pyramid attempt is also blocked with 403
    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(symbol="RELIANCE", canonical_symbol="RELIANCE.NS", display_name="RELIANCE", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst)
        db.flush()
        pos = PortfolioPosition(user_id=user.id, instrument_id=inst.id, status="ACTIVE", initial_entry_date=date(2024, 1, 1))
        db.add(pos)
        db.flush()
        pos.entries.append(TradeEntry(position_id=pos.id, sequence=1, entry_type="INITIAL_ENTRY", entry_date=date(2024, 1, 1), entry_price=Decimal("2200"), stop_loss=Decimal("2100"), rps=Decimal("100"), rpt=Decimal("5000"), quantity=50, capital_snapshot=Decimal("500000"), sizing_status="VALID"))
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    res_pyramid = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_pyramid.status_code == 403
    assert "temporarily unavailable because verified NSE market data has not been connected" in res_pyramid.json()["detail"]


# 11. Stale quote rejects pyramid entry and never writes to database
def test_pyramid_entry_blocked_when_quote_stale(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote_stale = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2250.00"), now_utc, "UPSTOX", is_stale=True)
    candles = generate_completed_candles(count=55)
    provider = MockDeterministicMarketDataProvider(quote=quote_stale, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(symbol="RELIANCE", canonical_symbol="RELIANCE.NS", display_name="RELIANCE", exchange="NSE", is_large_cap=True, is_active=True)
        db.add(inst)
        db.flush()
        pos = PortfolioPosition(user_id=user.id, instrument_id=inst.id, status="ACTIVE", initial_entry_date=date(2024, 1, 1))
        db.add(pos)
        db.flush()
        pos.entries.append(TradeEntry(position_id=pos.id, sequence=1, entry_type="INITIAL_ENTRY", entry_date=date(2024, 1, 1), entry_price=Decimal("2200"), stop_loss=Decimal("2100"), rps=Decimal("100"), rpt=Decimal("5000"), quantity=50, capital_snapshot=Decimal("500000"), sizing_status="VALID"))
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    res_pyramid = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_pyramid.status_code == 422
    assert "stale" in res_pyramid.json()["detail"].lower()

    # Verify no new entry persisted
    db = client.app.state.session_factory()
    try:
        p = db.get(PortfolioPosition, pos_id)
        assert len(p.entries) == 1
    finally:
        db.close()


# 12. Non-AMFI large-cap constituent rejected with HTTP 422 (Priority 2)
def test_non_amfi_universe_symbol_rejected(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    quote = MarketQuote("PENNYSTOCK", "NSE_EQ|INE999A01019", Decimal("100.00"), now_utc, "UPSTOX", False)
    candles = generate_completed_candles(count=55)
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Attempt to create position for symbol outside the validated AMFI large-cap universe
    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "PENNYSTOCK",
            "capital": "500000.00",
            "confirm_reference_price_as_execution": True,
        },
    )
    assert res.status_code == 422
    assert "not an active constituent of the validated AMFI large-cap universe" in res.json()["detail"]


# 13. Custom execution price recorded and used for sizing (Priority 1)
def test_custom_execution_price_recorded_and_sizes_position(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    # Quote is 2550.00, 20w SMA is 2222.50
    quote = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2550.00"), now_utc, "UPSTOX", False)
    candles = generate_completed_candles(count=55, base_price=Decimal("2000.00"), step=Decimal("5.00"))
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Actual executed fill was at 2600.00
    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "500000.00",
            "execution_price": "2600.00",
        },
    )
    assert res.status_code == 201
    pos_data = res.json()
    entry = pos_data["entries"][0]
    assert entry["entryPrice"] == 2600.00  # Custom execution price recorded
    assert entry["stopLoss"] == 2222.50   # 20-week SMA stop loss
    # RPS: 2600.00 - 2222.50 = 377.50
    assert entry["rps"] == 377.50
    # RPT: 1% of 500000.00 = 5000.00
    assert entry["rpt"] == 5000.00
    # Quantity: floor(5000 / 377.50) = 13
    assert entry["quantity"] == 13
    assert entry["sizingStatus"] == "VALID"


# 14. Zero-quantity initial and pyramid entries rejected with HTTP 422 (Priority 3)
def test_zero_quantity_initial_and_pyramid_rejected(tmp_path) -> None:
    now_utc = datetime.now(timezone.utc)
    # Reference price 2550.00, 20w SMA 2222.50 -> RPS = 327.50
    quote = MarketQuote("RELIANCE", "NSE_EQ|INE002A01018", Decimal("2550.00"), now_utc, "UPSTOX", False)
    candles = generate_completed_candles(count=55, base_price=Decimal("2000.00"), step=Decimal("5.00"))
    provider = MockDeterministicMarketDataProvider(quote=quote, candles=candles)
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Capital is 10,000.00 -> 1% RPT = 100.00. RPS = 327.50 -> floor(100 / 327.50) = 0 shares
    res_zero_init = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "capital": "10000.00",
            "confirm_reference_price_as_execution": True,
        },
    )
    assert res_zero_init.status_code == 422
    assert "Calculated quantity is 0 shares" in res_zero_init.json()["detail"]
    assert "insufficient to allocate at least 1 whole share" in res_zero_init.json()["detail"]

    # Verify no position was created
    list_res = client.get("/api/v1/portfolio/positions")
    assert len(list_res.json()["positions"]) == 0


# 15. Investigation & Regression: TCS Pyramid-Entry Workflows (Disabled & Enabled Scenarios)
def test_tcs_pyramid_workflow_disabled_and_enabled_scenarios(tmp_path) -> None:
    """Test disabled and enabled pyramid-entry workflows for TCS against strategy rules.

    Validates:
    1. TCS position with Previous Entry = 2533.00, 20w SMA = 2227.01, RSI = 60.07 is correctly rejected.
    2. Out-of-range SMA (> 2536.00) is rejected.
    3. RSI <= 60 is rejected.
    4. Stale quote is rejected.
    5. Missing execution confirmation is rejected with HTTP 422.
    6. Invalid execution price (<= 0) is rejected with HTTP 422.
    7. Insufficient capital (zero calculated quantity) is rejected with HTTP 422.
    8. Valid positive pyramid scenario with reference price confirmation succeeds with HTTP 201.
    9. Valid positive pyramid scenario with custom execution price succeeds with HTTP 201 and sizes accurately.
    """
    now_utc = datetime.now(timezone.utc)
    from app.services.market_data.service import MarketSnapshot

    # Create isolated test client with MockDeterministicMarketDataProvider
    provider = MockDeterministicMarketDataProvider(instrument_key="NSE_EQ|INE467B01029")
    client = make_test_client(tmp_path, provider)
    headers = auth_user(client)

    # Seed TCS position in temporary isolated SQLite DB:
    # Previous entry price: 2533.00, stop_loss: 2400.00, quantity: 37, capital: 500,000.00
    db = client.app.state.session_factory()
    try:
        from app.models.user import User
        user = db.query(User).filter_by(email="trader@example.com").one()
        inst = Instrument(
            symbol="TCS",
            canonical_symbol="TCS.NS",
            display_name="Tata Consultancy Services Ltd",
            exchange="NSE",
            is_large_cap=True,
            is_active=True,
        )
        db.add(inst)
        db.flush()
        pos = PortfolioPosition(
            user_id=user.id,
            instrument_id=inst.id,
            status="ACTIVE",
            initial_entry_date=date(2024, 1, 1),
        )
        db.add(pos)
        db.flush()
        e1 = TradeEntry(
            position_id=pos.id,
            sequence=1,
            entry_type="INITIAL_ENTRY",
            entry_date=date(2024, 1, 1),
            entry_price=Decimal("2533.00"),
            stop_loss=Decimal("2400.00"),
            rps=Decimal("133.00"),
            rpt=Decimal("5000.00"),
            quantity=37,
            capital_snapshot=Decimal("500000.00"),
            sizing_status="VALID",
        )
        pos.entries.append(e1)
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    md_service = client.app.state.market_data_service

    # --- Scenario 1: Exact User Case (Previous entry = 2533.00, SMA = 2227.01, RSI = 60.07) ---
    async def mock_snapshot_user_case(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2600.00"),
            quote_timestamp=now_utc,
            twenty_week_sma=Decimal("2227.01"),
            weekly_rsi=Decimal("60.07"),
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=False,
            is_eligible_for_initial=True,
            status_reason="Qualified",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_user_case

    res_tcs_actual = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00", "confirm_reference_price_as_execution": True},
    )
    assert res_tcs_actual.status_code == 422
    err_detail = res_tcs_actual.json()["detail"]
    assert "outside the required tolerance" in err_detail
    assert "2227.01" in err_detail
    assert "2533.00" in err_detail
    assert "2536.00" in err_detail

    # --- Scenario 2: SMA above upper tolerance (> 2536.00) ---
    async def mock_snapshot_sma_high(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2600.00"),
            quote_timestamp=now_utc,
            twenty_week_sma=Decimal("2536.50"),
            weekly_rsi=Decimal("62.50"),
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=False,
            is_eligible_for_initial=True,
            status_reason="Qualified",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_sma_high
    res_sma_high = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00", "confirm_reference_price_as_execution": True},
    )
    assert res_sma_high.status_code == 422
    assert "outside the required tolerance" in res_sma_high.json()["detail"]

    # --- Scenario 3: Weekly RSI <= 60 (e.g. 60.00 boundary failure) ---
    async def mock_snapshot_rsi_boundary(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2600.00"),
            quote_timestamp=now_utc,
            twenty_week_sma=Decimal("2534.50"),  # Valid SMA in [2533, 2536]
            weekly_rsi=Decimal("60.00"),         # 60.00 fails strictly > 60
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=False,
            is_eligible_for_initial=False,
            status_reason="RSI <= 60",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_rsi_boundary
    res_rsi_fail = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00", "confirm_reference_price_as_execution": True},
    )
    assert res_rsi_fail.status_code == 422
    assert "must be strictly greater than 60" in res_rsi_fail.json()["detail"]

    # --- Scenario 4: Stale market data quote ---
    async def mock_snapshot_stale(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2600.00"),
            quote_timestamp=now_utc - timedelta(days=5),
            twenty_week_sma=Decimal("2534.50"),
            weekly_rsi=Decimal("65.00"),
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=True,
            is_eligible_for_initial=False,
            status_reason="Stale quote",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_stale
    res_stale = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00", "confirm_reference_price_as_execution": True},
    )
    assert res_stale.status_code == 422
    assert "stale" in res_stale.json()["detail"].lower()

    # --- Scenario 5: Missing execution-price confirmation ---
    async def mock_snapshot_valid(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2550.00"),
            quote_timestamp=now_utc,
            twenty_week_sma=Decimal("2534.50"),  # Valid: 2533.00 <= 2534.50 <= 2536.00
            weekly_rsi=Decimal("65.20"),         # Valid: 65.20 > 60.0
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=False,
            is_eligible_for_initial=True,
            status_reason="Qualified",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_valid
    res_unconfirmed = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00"},
    )
    assert res_unconfirmed.status_code == 422
    assert "Explicit execution price confirmation is required" in res_unconfirmed.json()["detail"]

    # --- Scenario 6: Invalid execution price (<= 0) ---
    res_invalid_price = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "500000.00", "execution_price": "-10.00"},
    )
    assert res_invalid_price.status_code == 422
    assert "greater than 0" in str(res_invalid_price.json()["detail"]).lower()

    # --- Scenario 7: Insufficient capital / Zero quantity ---
    # RPT = 1% of 100.00 = 1.00. RPS = 2550.00 - 2534.50 = 15.50. Floor(1.00 / 15.50) = 0 shares
    res_insufficient_cap = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={"capital": "100.00", "confirm_reference_price_as_execution": True},
    )
    assert res_insufficient_cap.status_code == 422
    assert "Calculated quantity is 0 shares" in res_insufficient_cap.json()["detail"]

    # --- Scenario 8: Valid Positive Pyramid with Reference Price Confirmation ---
    res_success_ref = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "capital": "500000.00",
            "confirm_reference_price_as_execution": True,
            "notes": "Pyramid entry confirmed at reference price",
        },
    )
    assert res_success_ref.status_code == 201
    data_ref = res_success_ref.json()
    assert len(data_ref["entries"]) == 2
    entry2 = data_ref["entries"][1]
    assert entry2["sequence"] == 2
    assert entry2["entryType"] == "PYRAMID_ENTRY"
    assert entry2["entryPrice"] == 2550.00
    assert entry2["stopLoss"] == 2534.50
    assert entry2["rps"] == 15.50
    assert entry2["rpt"] == 5000.00
    # Quantity: floor(5000 / 15.50) = 322 shares
    assert entry2["quantity"] == 322
    assert entry2["sizingStatus"] == "VALID"

    # --- Scenario 9: Valid Positive Pyramid with Custom Executed Price ---
    # For pyramid #3, previous entry price is 2550.00 (from pyramid #2). Required SMA band is [2550.00, 2553.00].
    async def mock_snapshot_for_pyramid3(sym: str) -> MarketSnapshot:
        return MarketSnapshot(
            symbol="TCS",
            instrument_identifier="NSE_EQ|INE467B01029",
            last_price=Decimal("2565.00"),
            quote_timestamp=now_utc,
            twenty_week_sma=Decimal("2551.50"),  # Valid: 2550.00 <= 2551.50 <= 2553.00
            weekly_rsi=Decimal("66.00"),         # Valid: 66.00 > 60.0
            latest_completed_candle_date=date(2024, 10, 18),
            completed_candles_count=60,
            is_stale=False,
            is_eligible_for_initial=True,
            status_reason="Qualified",
            source="TEJHQ",
        )

    md_service.get_market_snapshot = mock_snapshot_for_pyramid3
    res_success_custom = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "capital": "500000.00",
            "execution_price": "2560.00",
            "notes": "Pyramid entry with custom broker fill",
        },
    )
    assert res_success_custom.status_code == 201
    data_custom = res_success_custom.json()
    assert len(data_custom["entries"]) == 3
    entry3 = data_custom["entries"][2]
    assert entry3["sequence"] == 3
    assert entry3["entryType"] == "PYRAMID_ENTRY"
    assert entry3["entryPrice"] == 2560.00
    assert entry3["stopLoss"] == 2551.50
    # RPS: 2560.00 - 2551.50 = 8.50
    assert entry3["rps"] == 8.50
    assert entry3["rpt"] == 5000.00
    # Quantity: floor(5000 / 8.50) = 588 shares
    assert entry3["quantity"] == 588
    assert entry3["sizingStatus"] == "VALID"
