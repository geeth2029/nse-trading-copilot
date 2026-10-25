"""Tests for Upstox market data provider adapter, instrument mapping, caching, and error handling."""

import asyncio
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import gzip
import json

import httpx
import pytest

from app.core.config import Settings
from app.services.market_data.base import MarketQuote, WeeklyCandle
from app.services.market_data.cache import MarketDataCache
from app.services.market_data.calendar import IST, NSETradingCalendar
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MalformedDataError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
)
from app.services.market_data.indicators import calculate_technical_indicators
from app.services.market_data.upstox import UpstoxMarketDataProvider

SAMPLE_INSTRUMENTS = [
    {
        "segment": "NSE_EQ",
        "instrument_type": "EQ",
        "trading_symbol": "RELIANCE",
        "instrument_key": "NSE_EQ|INE002A01018",
        "isin": "INE002A01018",
    },
    {
        "segment": "NSE_EQ",
        "instrument_type": "EQ",
        "trading_symbol": "INFY",
        "instrument_key": "NSE_EQ|INE009A01021",
        "isin": "INE009A01021",
    },
    {
        "segment": "NSE_EQ",
        "instrument_type": "EQ",
        "trading_symbol": "TCS",
        "instrument_key": "NSE_EQ|INE467B01029",
        "isin": "INE467B01029",
    },
    # Inappropriate/non-equity instrument to test filtering:
    {
        "segment": "NSE_FO",
        "instrument_type": "FUTSTK",
        "trading_symbol": "RELIANCE26OCTFUT",
        "instrument_key": "NSE_FO|12345",
    },
    {
        "segment": "BSE_EQ",
        "instrument_type": "EQ",
        "trading_symbol": "BSESTK",
        "instrument_key": "BSE_EQ|500325",
    },
]


def make_test_settings(
    token: str | None = "mock-analytics-token",
    master_url: str = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",
) -> Settings:
    return Settings(
        upstox_api_base_url="https://api.upstox.test",
        upstox_analytics_token=token,
        upstox_request_timeout_seconds=2.0,
        upstox_quote_market_hours_ttl_seconds=30,
        upstox_quote_off_market_ttl_seconds=3600,
        upstox_weekly_candle_ttl_seconds=86400,
        upstox_instrument_master_ttl_seconds=86400,
        upstox_instrument_master_url=master_url,
    )


# 1. Successful quote-response parsing, timestamp mapping, and source identification
def test_quote_parsing_success_and_source_identification() -> None:
    async def _test() -> None:
        now_utc = datetime.now(timezone.utc)
        trade_time_ms = int(now_utc.timestamp() * 1000)

        def handler(request: httpx.Request) -> httpx.Response:
            assert "Authorization" in request.headers
            assert request.headers["Authorization"] == "Bearer mock-analytics-token"
            assert "instrument_key=NSE_EQ%7CINE002A01018" in str(request.url) or "instrument_key=NSE_EQ|INE002A01018" in str(request.url)

            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "symbol": "NSE_EQ:RELIANCE",
                            "instrument_token": "NSE_EQ|INE002A01018",
                            "last_price": 2985.50,
                            "last_trade_time": str(trade_time_ms),
                            "timestamp": now_utc.isoformat(),
                        }
                    },
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
            cache=MarketDataCache(),
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        quote = await adapter.get_reference_quote("RELIANCE")

        assert isinstance(quote, MarketQuote)
        assert quote.symbol == "RELIANCE"
        assert quote.instrument_identifier == "NSE_EQ|INE002A01018"
        assert quote.last_price == Decimal("2985.50")
        assert quote.source == "UPSTOX"
        assert quote.is_stale is False
        assert quote.timestamp.tzinfo is not None

    asyncio.run(_test())


# 2. Successful weekly-candle parsing with chronological ordering and start-of-week date resolution
def test_weekly_candle_parsing_and_chronological_ordering() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert "/v3/historical-candle/" in str(request.url)
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "candles": [
                            # Upstox returns newest first, often with Monday start-of-week timestamps
                            ["2024-03-04T00:00:00+05:30", 3000.0, 3050.0, 2980.0, 3040.0, 500000, 0],
                            ["2024-02-26T00:00:00+05:30", 2950.0, 3010.0, 2920.0, 2990.0, 450000, 0],
                            ["2024-02-19T00:00:00+05:30", 2900.0, 2960.0, 2880.0, 2940.0, 400000, 0],
                        ]
                    },
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
            cache=MarketDataCache(),
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        candles = await adapter.get_historical_weekly_candles("RELIANCE", limit_weeks=3)

        assert len(candles) == 3
        # Verify chronological ascending order and mapping of Monday timestamps to weekly closing session dates
        assert candles[0].candle_date == date(2024, 2, 23)  # Friday close
        assert candles[1].candle_date == date(2024, 3, 1)   # Friday close
        # Note: 2024-03-08 was Maha Shivratri (NSE Friday holiday), so closing session was Thursday 2024-03-07!
        assert candles[2].candle_date == date(2024, 3, 7)

        assert candles[0].close_price == Decimal("2940.0")
        assert candles[1].close_price == Decimal("2990.0")
        assert candles[2].close_price == Decimal("3040.0")
        assert candles[0].volume == 400000
        assert all(c.is_completed for c in candles)

    asyncio.run(_test())


# 3. Correct instrument-master parsing and NSE equity mapping
def test_instrument_master_parsing_and_mapping() -> None:
    adapter = UpstoxMarketDataProvider(settings=make_test_settings())
    count = adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

    # Only RELIANCE, INFY, TCS should be indexed (segment=="NSE_EQ", type=="EQ")
    assert count == 3
    assert adapter.resolve_instrument_key("RELIANCE") == "NSE_EQ|INE002A01018"
    assert adapter.resolve_instrument_key("reliance") == "NSE_EQ|INE002A01018"
    assert adapter.resolve_instrument_key("INFY", isin="INE009A01021") == "NSE_EQ|INE009A01021"


# 4. Gzip-compressed official instrument master download and decompression
def test_gzip_compressed_instrument_master_download() -> None:
    async def _test() -> None:
        json_bytes = json.dumps(SAMPLE_INSTRUMENTS).encode("utf-8")
        gzipped_bytes = gzip.compress(json_bytes)

        def handler(request: httpx.Request) -> httpx.Response:
            assert "assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz" in str(request.url)
            return httpx.Response(200, content=gzipped_bytes, headers={"Content-Type": "application/gzip"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )

        key = await adapter.get_instrument_identifier("RELIANCE")
        assert key == "NSE_EQ|INE002A01018"

    asyncio.run(_test())


# 5. Rejection of corrupted gzip or invalid JSON in instrument master download
def test_rejection_of_corrupted_gzip_instrument_master() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"invalid-not-gzip-bytes")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )

        with pytest.raises(MalformedDataError) as exc_info:
            await adapter.ensure_instrument_master_loaded()
        assert "gzip" in str(exc_info.value).lower()

    asyncio.run(_test())


def test_rejection_of_invalid_json_inside_gzip() -> None:
    async def _test() -> None:
        corrupt_json = b"{not-valid-json"
        gzipped_bytes = gzip.compress(corrupt_json)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=gzipped_bytes)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )

        with pytest.raises(MalformedDataError) as exc_info:
            await adapter.ensure_instrument_master_loaded()
        assert "json" in str(exc_info.value).lower()

    asyncio.run(_test())


# 6. Cache preservation after a failed refresh
def test_cache_preservation_after_failed_refresh() -> None:
    async def _test() -> None:
        adapter = UpstoxMarketDataProvider(settings=make_test_settings())
        # Pre-load valid instruments
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)
        assert adapter.resolve_instrument_key("RELIANCE") == "NSE_EQ|INE002A01018"

        # Now attempt a download that fails with HTTP 500
        def fail_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Internal Server Error")

        client = httpx.AsyncClient(transport=httpx.MockTransport(fail_handler))
        adapter._client = client

        # Force a refresh attempt
        adapter._instruments_loaded = False
        await adapter.ensure_instrument_master_loaded()

        # Previous valid mapping MUST be preserved, not wiped or corrupted
        assert adapter.resolve_instrument_key("RELIANCE") == "NSE_EQ|INE002A01018"
        assert adapter.resolve_instrument_key("INFY") == "NSE_EQ|INE009A01021"

    asyncio.run(_test())


# 7. Rejection of unknown, ambiguous, malformed, or inappropriate instruments
def test_rejection_of_unknown_or_inappropriate_instruments() -> None:
    adapter = UpstoxMarketDataProvider(settings=make_test_settings())
    adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

    # Unknown symbol
    with pytest.raises(InstrumentNotFoundError) as exc_info:
        adapter.resolve_instrument_key("NONEXISTENT")
    assert "NONEXISTENT" in str(exc_info.value)

    # Filtered non-equity symbol
    with pytest.raises(InstrumentNotFoundError):
        adapter.resolve_instrument_key("RELIANCE26OCTFUT")

    # Filtered BSE instrument
    with pytest.raises(InstrumentNotFoundError):
        adapter.resolve_instrument_key("BSESTK")

    # Empty symbol
    with pytest.raises(InstrumentNotFoundError):
        adapter.resolve_instrument_key("")

    # Mismatched ISIN
    with pytest.raises(InstrumentNotFoundError) as exc_info:
        adapter.resolve_instrument_key("RELIANCE", isin="INE999999999")
    assert "does not match symbol" in str(exc_info.value)


# 8. Missing-token configuration behavior
def test_missing_token_configuration_raises_without_http_calls() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            pytest.fail("HTTP request should not have been made when token is missing.")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(token=None),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(ProviderAuthenticationError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")
        assert "Analytics Token is not configured" in str(exc_info.value)

    asyncio.run(_test())


# 8b. Consistent Analytics Token environment variable binding
def test_analytics_token_environment_variable_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    # 1. When UPSTOX_ANALYTICS_TOKEN is set
    monkeypatch.setenv("UPSTOX_ANALYTICS_TOKEN", "test-analytics-token-abc")
    s1 = Settings.from_environment()
    assert s1.upstox_analytics_token == "test-analytics-token-abc"

    # 2. When UPSTOX_ANALYTICS_TOKEN is unset
    monkeypatch.delenv("UPSTOX_ANALYTICS_TOKEN", raising=False)
    s2 = Settings.from_environment()
    assert s2.upstox_analytics_token is None

    # 3. When whitespace only, should fail safely without leaking
    monkeypatch.setenv("UPSTOX_ANALYTICS_TOKEN", "   ")
    s3 = Settings.from_environment()
    adapter = UpstoxMarketDataProvider(settings=s3)
    with pytest.raises(ProviderAuthenticationError) as exc_info:
        adapter._get_auth_headers()
    assert "Analytics Token is not configured" in str(exc_info.value)


# 9. Provider HTTP 401/403 handling without token leakage
def test_http_401_403_handling_without_token_leakage() -> None:
    async def _test() -> None:
        secret_token = "super-secret-token-12345"

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, text=f"Unauthorized access with token {secret_token}")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(token=secret_token),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(ProviderAuthenticationError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")

        error_message = str(exc_info.value)
        assert secret_token not in error_message
        assert "authentication failed" in error_message.lower()

    asyncio.run(_test())


# 10. HTTP 429 handling, bounded retries, and Retry-After
def test_http_429_rate_limiting_and_retry_after() -> None:
    async def _test() -> None:
        call_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            return httpx.Response(429, headers={"Retry-After": "0.01"}, json={"status": "error", "message": "rate limit"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(RateLimitExceededError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")

        # 1 initial + 2 retries = 3 attempts total (bounded retries)
        assert call_count == 3
        assert exc_info.value.retry_after == 0.01

    asyncio.run(_test())


# 11. Timeout, connection failure, HTTP 5xx, malformed JSON, and missing response fields
def test_timeout_and_connection_failures() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("Connection timed out to Upstox API")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(MarketDataUnavailableError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")
        assert "timeout" in str(exc_info.value).lower() or "connection" in str(exc_info.value).lower()

    asyncio.run(_test())


def test_http_5xx_server_error() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="Service Unavailable")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(MarketDataUnavailableError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")
        assert "503" in str(exc_info.value)

    asyncio.run(_test())


def test_malformed_json_response() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="Not a valid JSON payload")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(MalformedDataError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")
        assert "JSON" in str(exc_info.value)

    asyncio.run(_test())


def test_missing_price_or_timestamp_fields() -> None:
    async def _test() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "symbol": "NSE_EQ:RELIANCE",
                            # Missing last_price and timestamp
                        }
                    },
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = UpstoxMarketDataProvider(
            settings=make_test_settings(),
            client=client,
        )
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        with pytest.raises(MalformedDataError) as exc_info:
            await adapter.get_reference_quote("RELIANCE")
        assert "last_price" in str(exc_info.value).lower()


# 12. Quote freshness and stale-response handling
def test_quote_freshness_during_market_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _test() -> None:
        # Set simulated time to Wednesday 12:00 IST (active trading hours)
        wed_12pm_ist = datetime(2026, 10, 21, 12, 0, 0, tzinfo=IST)
        now_utc = wed_12pm_ist.astimezone(timezone.utc)

        class MockDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz == timezone.utc:
                    return now_utc
                if tz == IST:
                    return wed_12pm_ist
                return wed_12pm_ist

        monkeypatch.setattr("app.services.market_data.upstox.datetime", MockDatetime)

        # 1. Fresh quote within 30s limit (trade time 10 seconds ago)
        trade_time_fresh = now_utc - timedelta(seconds=10)

        def handler_fresh(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(trade_time_fresh.timestamp() * 1000)),
                        }
                    },
                },
            )

        client_fresh = httpx.AsyncClient(transport=httpx.MockTransport(handler_fresh))
        adapter_fresh = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_fresh)
        adapter_fresh.load_instrument_master(SAMPLE_INSTRUMENTS)

        quote = await adapter_fresh.get_reference_quote("RELIANCE")
        assert quote.is_stale is False

        # 2. Stale quote exceeding 30s market-hours limit (trade time 45 seconds ago)
        trade_time_stale = now_utc - timedelta(seconds=45)

        def handler_stale(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(trade_time_stale.timestamp() * 1000)),
                        }
                    },
                },
            )

        client_stale = httpx.AsyncClient(transport=httpx.MockTransport(handler_stale))
        adapter_stale = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_stale)
        adapter_stale.load_instrument_master(SAMPLE_INSTRUMENTS)

        quote_stale = await adapter_stale.get_reference_quote("RELIANCE")
        assert quote_stale.is_stale is True

    asyncio.run(_test())


# 12b. Distinct trade timestamp vs provider snapshot timestamp & freshness enforcement
def test_quote_distinct_timestamps_and_staleness_enforcement(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _test() -> None:
        wed_12pm_ist = datetime(2026, 10, 21, 12, 0, 0, tzinfo=IST)
        now_utc = wed_12pm_ist.astimezone(timezone.utc)

        class MockDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz == timezone.utc:
                    return now_utc
                if tz == IST:
                    return wed_12pm_ist
                return wed_12pm_ist

        monkeypatch.setattr("app.services.market_data.upstox.datetime", MockDatetime)

        # Case A: Old last-trade (45s ago) but recently generated HTTP response (2s ago)
        # Application MUST NOT consider old trade fresh merely because provider response was recent!
        trade_45s_ago = now_utc - timedelta(seconds=45)
        response_2s_ago = now_utc - timedelta(seconds=2)

        def handler_old_trade_recent_response(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(trade_45s_ago.timestamp() * 1000)),
                            "timestamp": response_2s_ago.isoformat(),
                        }
                    },
                },
            )

        client_a = httpx.AsyncClient(transport=httpx.MockTransport(handler_old_trade_recent_response))
        adapter_a = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_a)
        adapter_a.load_instrument_master(SAMPLE_INSTRUMENTS)
        quote_a = await adapter_a.get_reference_quote("RELIANCE")
        assert quote_a.is_stale is True  # Stale because trade_age (45s) > limit (30s)

        # Case B: Fresh trade (10s ago) but stale provider snapshot generation (45s ago)
        trade_10s_ago = now_utc - timedelta(seconds=10)
        response_45s_ago = now_utc - timedelta(seconds=45)

        def handler_fresh_trade_stale_response(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(trade_10s_ago.timestamp() * 1000)),
                            "timestamp": response_45s_ago.isoformat(),
                        }
                    },
                },
            )

        client_b = httpx.AsyncClient(transport=httpx.MockTransport(handler_fresh_trade_stale_response))
        adapter_b = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_b)
        adapter_b.load_instrument_master(SAMPLE_INSTRUMENTS)
        quote_b = await adapter_b.get_reference_quote("RELIANCE")
        assert quote_b.is_stale is True  # Stale because provider response age (45s) > limit (30s)

        # Case C: Future trade timestamp beyond clock drift tolerance (> 5s in future)
        trade_future = now_utc + timedelta(seconds=20)

        def handler_future(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(trade_future.timestamp() * 1000)),
                        }
                    },
                },
            )

        client_c = httpx.AsyncClient(transport=httpx.MockTransport(handler_future))
        adapter_c = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_c)
        adapter_c.load_instrument_master(SAMPLE_INSTRUMENTS)
        quote_c = await adapter_c.get_reference_quote("RELIANCE")
        assert quote_c.is_stale is True

    asyncio.run(_test())


# 12c. Missing and malformed timestamp handling
def test_quote_missing_or_malformed_timestamps() -> None:
    async def _test() -> None:
        adapter = UpstoxMarketDataProvider(settings=make_test_settings())
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        # 1. Missing last_trade_time
        def handler_missing_trade_time(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            # No last_trade_time
                            "timestamp": "2026-10-21T12:00:00Z",
                        }
                    },
                },
            )

        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(handler_missing_trade_time))
        with pytest.raises(MalformedDataError) as exc_info_1:
            await adapter.get_reference_quote("RELIANCE")
        assert "missing required 'last_trade_time'" in str(exc_info_1.value).lower()

        # 2. Malformed last_trade_time (unparseable string)
        def handler_malformed_trade_time(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": "invalid_timestamp_value",
                        }
                    },
                },
            )

        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(handler_malformed_trade_time))
        with pytest.raises(MalformedDataError) as exc_info_2:
            await adapter.get_reference_quote("RELIANCE")
        assert "malformed 'last_trade_time'" in str(exc_info_2.value).lower()

        # 3. Malformed provider timestamp
        def handler_malformed_provider_ts(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
                            "timestamp": "bad_iso_timestamp",
                        }
                    },
                },
            )

        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(handler_malformed_provider_ts))
        with pytest.raises(MalformedDataError) as exc_info_3:
            await adapter.get_reference_quote("RELIANCE")
        assert "malformed provider 'timestamp'" in str(exc_info_3.value).lower()

    asyncio.run(_test())


# 12d. Off-market quote freshness policy
def test_quote_off_market_freshness_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _test() -> None:
        # Simulate Saturday morning (off-market)
        # Saturday: 2026-10-24 11:00:00 IST
        # Latest completed trading session was Friday 2026-10-23
        sat_11am_ist = datetime(2026, 10, 24, 11, 0, 0, tzinfo=IST)
        sat_now_utc = sat_11am_ist.astimezone(timezone.utc)

        class MockDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz == timezone.utc:
                    return sat_now_utc
                if tz == IST:
                    return sat_11am_ist
                return sat_11am_ist

        monkeypatch.setattr("app.services.market_data.upstox.datetime", MockDatetime)

        # Case A: Trade from Friday 15:20 IST (the latest completed trading session) -> Fresh off-market!
        friday_trade_ist = datetime(2026, 10, 23, 15, 20, 0, tzinfo=IST)
        friday_trade_utc = friday_trade_ist.astimezone(timezone.utc)

        def handler_friday_trade(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(friday_trade_utc.timestamp() * 1000)),
                        }
                    },
                },
            )

        client_a = httpx.AsyncClient(transport=httpx.MockTransport(handler_friday_trade))
        adapter_a = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_a)
        adapter_a.load_instrument_master(SAMPLE_INSTRUMENTS)
        quote_a = await adapter_a.get_reference_quote("RELIANCE")
        assert quote_a.is_stale is False

        # Case B: Trade from Thursday 2026-10-22 (older than the latest completed session Friday 2026-10-23) -> Stale!
        thursday_trade_ist = datetime(2026, 10, 22, 15, 20, 0, tzinfo=IST)
        thursday_trade_utc = thursday_trade_ist.astimezone(timezone.utc)

        def handler_thursday_trade(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50,
                            "last_trade_time": str(int(thursday_trade_utc.timestamp() * 1000)),
                        }
                    },
                },
            )

        client_b = httpx.AsyncClient(transport=httpx.MockTransport(handler_thursday_trade))
        adapter_b = UpstoxMarketDataProvider(settings=make_test_settings(), client=client_b)
        adapter_b.load_instrument_master(SAMPLE_INSTRUMENTS)
        quote_b = await adapter_b.get_reference_quote("RELIANCE")
        assert quote_b.is_stale is True

    asyncio.run(_test())


# 13. Normal Friday close boundary conditions around 15:30 IST
def test_normal_friday_close_boundary_conditions() -> None:
    cal = NSETradingCalendar()
    candle_date = date(2026, 10, 23)  # Normal Friday in 2026

    # 1. Friday at 15:29:59 IST (1 second before close) -> Incomplete
    time_before_close = datetime(2026, 10, 23, 15, 29, 59, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=time_before_close) is False

    # 2. Friday at 15:30:00 IST (exact close) -> Completed
    time_at_close = datetime(2026, 10, 23, 15, 30, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=time_at_close) is True

    # 3. Saturday (weekend) -> Completed
    time_weekend = datetime(2026, 10, 24, 10, 0, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=time_weekend) is True


# 14. Friday exchange holiday / shortened week handling
def test_friday_holiday_shortened_week_completion() -> None:
    # Good Friday 2024: Friday 2024-03-29 was an exchange holiday.
    # The week's final trading session was Thursday 2024-03-28.
    cal = NSETradingCalendar()
    candle_date = date(2024, 3, 25)  # Monday of Good Friday week

    closing_date = cal.get_weekly_closing_date(candle_date)
    assert closing_date == date(2024, 3, 28)  # Thursday!

    # On Thursday at 15:29:59 IST -> Incomplete
    thursday_before = datetime(2024, 3, 28, 15, 29, 59, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=thursday_before) is False

    # On Thursday at 15:30:00 IST -> Completed
    thursday_after = datetime(2024, 3, 28, 15, 30, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=thursday_after) is True

    # On Friday 2024-03-29 (holiday) at 10:00:00 IST -> Completed
    friday_holiday = datetime(2024, 3, 29, 10, 0, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=friday_holiday) is True


# 15. The currently forming week is marked incomplete
def test_currently_forming_week_is_incomplete() -> None:
    cal = NSETradingCalendar()
    # Wednesday of active week
    candle_date = date(2026, 10, 21)
    now_wednesday = datetime(2026, 10, 21, 11, 30, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=now_wednesday) is False


# 16. Conservative fallback when calendar is unknown
def test_conservative_fallback_for_unverified_future_year() -> None:
    cal = NSETradingCalendar()
    # Year 2099 is not in verified holiday calendar
    candle_date = date(2099, 10, 16)  # Friday in 2099
    now_friday_evening = datetime(2099, 10, 16, 16, 0, 0, tzinfo=IST)

    # Conservative fallback: cannot establish schedule for unknown year during forming week
    assert cal.is_week_completed(candle_date, now=now_friday_evening) is False

    # Once week has completely elapsed (Monday of next week):
    now_next_week = datetime(2099, 10, 19, 9, 15, 0, tzinfo=IST)
    assert cal.is_week_completed(candle_date, now=now_next_week) is True


# 17. Cache hit, expiration, invalidation, and concurrent single-flight behavior
def test_cache_hit_and_invalidation() -> None:
    async def _test() -> None:
        api_calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal api_calls
            api_calls += 1
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 2985.50 + api_calls,
                            "last_trade_time": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
                        }
                    },
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = MarketDataCache()
        adapter = UpstoxMarketDataProvider(settings=make_test_settings(), client=client, cache=cache)
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        # 1st call -> Cache miss, API called
        q1 = await adapter.get_reference_quote("RELIANCE")
        assert api_calls == 1
        assert q1.last_price == Decimal("2986.50")

        # 2nd call -> Cache hit, API not called
        q2 = await adapter.get_reference_quote("RELIANCE")
        assert api_calls == 1
        assert q2.last_price == Decimal("2986.50")

        # Invalidate quote
        cache.invalidate("quote:RELIANCE")

        # 3rd call -> Cache miss, API called again
        q3 = await adapter.get_reference_quote("RELIANCE")
        assert api_calls == 2
        assert q3.last_price == Decimal("2987.50")

    asyncio.run(_test())


def test_concurrent_request_single_flight_deduplication() -> None:
    async def _test() -> None:
        api_calls = 0

        async def slow_handler(request: httpx.Request) -> httpx.Response:
            nonlocal api_calls
            api_calls += 1
            await asyncio.sleep(0.05)  # Simulate network latency
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "NSE_EQ:RELIANCE": {
                            "last_price": 3000.0,
                            "last_trade_time": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
                        }
                    },
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(slow_handler))
        cache = MarketDataCache()
        adapter = UpstoxMarketDataProvider(settings=make_test_settings(), client=client, cache=cache)
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        # Launch 5 concurrent requests for the exact same symbol
        results = await asyncio.gather(
            adapter.get_reference_quote("RELIANCE"),
            adapter.get_reference_quote("RELIANCE"),
            adapter.get_reference_quote("RELIANCE"),
            adapter.get_reference_quote("RELIANCE"),
            adapter.get_reference_quote("RELIANCE"),
        )

        # All 5 return the same quote, but only 1 API call was executed due to single-flight locking
        assert len(results) == 5
        assert api_calls == 1
        assert all(r.last_price == Decimal("3000.0") for r in results)

    asyncio.run(_test())


# 18. Ensuring provider failures never trigger mock-data fallback
def test_provider_failures_never_fallback_to_mock_data() -> None:
    async def _test() -> None:
        def failure_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Internal Server Error")

        client = httpx.AsyncClient(transport=httpx.MockTransport(failure_handler))
        adapter = UpstoxMarketDataProvider(settings=make_test_settings(), client=client)
        adapter.load_instrument_master(SAMPLE_INSTRUMENTS)

        # The adapter MUST raise MarketDataUnavailableError and never silently return mock data
        with pytest.raises(MarketDataUnavailableError):
            await adapter.get_reference_quote("RELIANCE")

        with pytest.raises(MarketDataUnavailableError):
            await adapter.get_historical_weekly_candles("RELIANCE")

    asyncio.run(_test())


# 19. Incomplete candles are strictly excluded from SMA and RSI calculations
def test_incomplete_candles_excluded_from_technical_indicators() -> None:
    # Build 20 completed candles with close prices 100, 101, ..., 119
    # Average of 100..119 is 109.50
    candles: list[WeeklyCandle] = []
    base_date = date(2024, 1, 5)

    for i in range(20):
        candle_date = base_date + timedelta(weeks=i)
        price = Decimal(str(100 + i))
        candles.append(
            WeeklyCandle(
                symbol="RELIANCE",
                candle_date=candle_date,
                open_price=price,
                high_price=price + Decimal("2"),
                low_price=price - Decimal("2"),
                close_price=price,
                volume=100000,
                is_completed=True,
            )
        )

    # Append 1 incomplete current forming candle with wild price (e.g. 999.00)
    current_forming_date = base_date + timedelta(weeks=20)
    candles.append(
        WeeklyCandle(
            symbol="RELIANCE",
            candle_date=current_forming_date,
            open_price=Decimal("999"),
            high_price=Decimal("1005"),
            low_price=Decimal("990"),
            close_price=Decimal("999"),
            volume=50000,
            is_completed=False,  # Incomplete!
        )
    )

    indicators = calculate_technical_indicators("RELIANCE", candles)

    # The incomplete candle MUST be completely excluded
    assert indicators.completed_candles_count == 20
    assert indicators.latest_completed_candle_date == candles[19].candle_date
    assert indicators.twenty_week_sma == Decimal("109.50")
