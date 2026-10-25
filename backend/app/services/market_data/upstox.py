"""Upstox Market Data Provider Adapter for verified NSE equity quotes and historical candles."""

import asyncio
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import gzip
import json
import logging
from typing import Any

import httpx

from app.core.config import Settings
from app.services.market_data.base import MarketDataProvider, MarketQuote, WeeklyCandle
from app.services.market_data.cache import MarketDataCache
from app.services.market_data.calendar import IST, NSETradingCalendar
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MalformedDataError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
    StaleDataError,
)

logger = logging.getLogger(__name__)

# NSE Regular Market Hours: Monday(0) - Friday(4), 09:15 - 15:30 IST
NSE_MARKET_OPEN_TIME = time(9, 15)
NSE_MARKET_CLOSE_TIME = time(15, 30)


def is_nse_market_hours(dt: datetime | None = None) -> bool:
    """Determine whether the given or current time falls within active NSE equity trading hours."""
    current_dt = (dt or datetime.now(timezone.utc)).astimezone(IST)
    if current_dt.weekday() >= 5:  # Saturday or Sunday
        return False
    current_time = current_dt.time()
    return NSE_MARKET_OPEN_TIME <= current_time <= NSE_MARKET_CLOSE_TIME


def parse_timestamp_safe(ts_value: Any) -> datetime | None:
    """Parse various timestamp representations (ISO 8601 string, epoch ms, epoch s) to timezone-aware UTC datetime."""
    if ts_value is None:
        return None
    try:
        if isinstance(ts_value, (int, float)):
            # Distinguish epoch ms vs epoch s
            sec = ts_value / 1000.0 if ts_value > 1e11 else float(ts_value)
            return datetime.fromtimestamp(sec, tz=timezone.utc)
        if isinstance(ts_value, str):
            ts_str = ts_value.strip()
            # If all digits, treat as epoch ms
            if ts_str.isdigit():
                sec = int(ts_str) / 1000.0 if len(ts_str) >= 12 else float(ts_str)
                return datetime.fromtimestamp(sec, tz=timezone.utc)
            # Try ISO 8601 parsing
            dt = datetime.fromisoformat(ts_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=IST)
            return dt.astimezone(timezone.utc)
    except Exception:
        return None
    return None


class UpstoxMarketDataProvider(MarketDataProvider):
    """Upstox Market Data V3 provider adapter.

    Implements:
    - Current reference quotes via Full Market Quotes V3
    - Historical weekly candle series via Historical Candle V3 (`weeks/1`)
    - Official NSE Equity instrument master resolution from Upstox assets gzip master
    - In-memory caching with single-flight concurrent deduplication
    - Typed error handling with token redaction and bounded retries
    - NSE trading calendar aware weekly candle completion policy
    """

    def __init__(
        self,
        settings: Settings | None = None,
        client: httpx.AsyncClient | None = None,
        cache: MarketDataCache | None = None,
        calendar: NSETradingCalendar | None = None,
    ) -> None:
        self._settings = settings or Settings.from_environment()
        self._client = client
        self._cache = cache or MarketDataCache()
        self._calendar = calendar or NSETradingCalendar()

        # In-memory instrument lookup: symbol -> instrument_key (e.g. 'RELIANCE' -> 'NSE_EQ|INE002A01018')
        # Also supports ISIN lookup: isin -> instrument_key
        self._symbol_to_instrument: dict[str, str] = {}
        self._isin_to_instrument: dict[str, str] = {}
        self._instrument_to_symbol: dict[str, str] = {}
        self._instruments_loaded: bool = False
        self._instrument_lock = asyncio.Lock()

    def _get_auth_headers(self) -> dict[str, str]:
        """Construct secure authorization headers, failing safely if token is missing."""
        token = self._settings.upstox_analytics_token
        if not token or not token.strip():
            raise ProviderAuthenticationError(
                "Upstox Analytics Token is not configured. Market data operations cannot proceed."
            )
        return {
            "Authorization": f"Bearer {token.strip()}",
            "Accept": "application/json",
        }

    async def _get_client(self) -> httpx.AsyncClient:
        """Return the injected HTTP client or create an ad-hoc client."""
        if self._client is not None:
            return self._client
        return httpx.AsyncClient(timeout=self._settings.upstox_request_timeout_seconds)

    async def _execute_with_retry(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        params: dict[str, Any] | None = None,
        max_retries: int = 2,
    ) -> dict[str, Any]:
        """Execute HTTP request with token redaction, timeout protection, and bounded retries on 429/5xx."""
        client = await self._get_client()
        attempt = 0

        while True:
            attempt += 1
            try:
                response = await client.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    timeout=self._settings.upstox_request_timeout_seconds,
                )

                # Check status code
                if response.status_code in (401, 403):
                    # Redact any sensitive details
                    raise ProviderAuthenticationError(
                        "Upstox authentication failed. The configured Analytics Token is invalid or expired."
                    )

                if response.status_code == 429:
                    retry_after_header = response.headers.get("Retry-After")
                    retry_after_val: float | None = None
                    if retry_after_header:
                        try:
                            retry_after_val = float(retry_after_header)
                        except ValueError:
                            retry_after_val = None

                    if attempt <= max_retries:
                        sleep_seconds = min(retry_after_val if retry_after_val is not None else 1.0, 5.0)
                        logger.warning(
                            "Upstox rate limit hit (429). Retrying in %.2f seconds (attempt %d/%d).",
                            sleep_seconds,
                            attempt,
                            max_retries,
                        )
                        await asyncio.sleep(sleep_seconds)
                        continue

                    raise RateLimitExceededError(
                        "Upstox rate limit exceeded.",
                        retry_after=retry_after_val,
                    )

                if response.status_code >= 500:
                    if attempt <= max_retries:
                        sleep_seconds = min(0.5 * (2 ** (attempt - 1)), 2.0)
                        logger.warning(
                            "Upstox server error (%d). Retrying in %.2f seconds (attempt %d/%d).",
                            response.status_code,
                            sleep_seconds,
                            attempt,
                            max_retries,
                        )
                        await asyncio.sleep(sleep_seconds)
                        continue
                    raise MarketDataUnavailableError(
                        f"Upstox server returned temporary error ({response.status_code})."
                    )

                if response.status_code != 200:
                    raise MarketDataUnavailableError(
                        f"Upstox returned unexpected status code {response.status_code}."
                    )

                try:
                    payload = response.json()
                except Exception as exc:
                    raise MalformedDataError(f"Failed to parse Upstox JSON response: {exc}") from exc

                if not isinstance(payload, dict):
                    raise MalformedDataError("Upstox response payload is not a valid JSON object.")

                status_field = payload.get("status")
                if status_field != "success":
                    errors = payload.get("errors") or payload.get("message") or "Unknown provider failure"
                    raise MarketDataUnavailableError(f"Upstox API returned error status: {errors}")

                return payload

            except (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError) as exc:
                if attempt <= max_retries:
                    sleep_seconds = min(0.5 * (2 ** (attempt - 1)), 2.0)
                    logger.warning(
                        "Upstox network/timeout exception (%s). Retrying in %.2f seconds (attempt %d/%d).",
                        type(exc).__name__,
                        sleep_seconds,
                        attempt,
                        max_retries,
                    )
                    await asyncio.sleep(sleep_seconds)
                    continue
                raise MarketDataUnavailableError(
                    f"Market data request failed due to connection error or timeout: {type(exc).__name__}"
                ) from exc
            finally:
                # If we created an ad-hoc client, close it when done
                if self._client is None and attempt > max_retries:
                    await client.aclose()

    def load_instrument_master(self, raw_instruments: list[dict[str, Any]]) -> int:
        """Parse and index official Upstox instrument master records for NSE Equities.

        Filters strictly for:
        - segment == 'NSE_EQ'
        - instrument_type == 'EQ'
        - valid trading_symbol and instrument_key

        Atomically assigns mappings only if at least one valid instrument is parsed,
        ensuring existing cache or lookup state is never wiped or corrupted.

        Returns the count of successfully indexed equity instruments.
        """
        if not isinstance(raw_instruments, list):
            raise MalformedDataError("Instrument master payload must be a list of records.")

        symbol_map: dict[str, str] = {}
        isin_map: dict[str, str] = {}
        reverse_map: dict[str, str] = {}
        count = 0

        for item in raw_instruments:
            if not isinstance(item, dict):
                continue
            segment = item.get("segment")
            instrument_type = item.get("instrument_type")
            symbol = item.get("trading_symbol") or item.get("tradingsymbol")
            instrument_key = item.get("instrument_key")
            isin = item.get("isin")

            if segment != "NSE_EQ" or instrument_type != "EQ":
                continue
            if not symbol or not instrument_key:
                continue

            normalized_symbol = str(symbol).strip().upper()
            inst_key = str(instrument_key).strip()

            symbol_map[normalized_symbol] = inst_key
            reverse_map[inst_key] = normalized_symbol
            if isin and isinstance(isin, str) and isin.strip():
                isin_map[isin.strip().upper()] = inst_key
            count += 1

        if count == 0:
            if not self._instruments_loaded:
                raise MalformedDataError("Zero valid NSE equity instruments found in raw instrument master.")
            logger.warning("Empty or invalid instrument master parsed; retaining existing valid mappings.")
            return len(self._symbol_to_instrument)

        # Atomic assignment to prevent partial or corrupted mapping
        self._symbol_to_instrument = symbol_map
        self._isin_to_instrument = isin_map
        self._instrument_to_symbol = reverse_map
        self._instruments_loaded = True

        logger.info("Indexed %d NSE equity instruments from Upstox instrument master.", count)
        return count

    async def ensure_instrument_master_loaded(self) -> None:
        """Ensure instrument master is loaded, downloading from Upstox official assets if necessary."""
        if self._instruments_loaded:
            return

        if not self._settings.upstox_analytics_token or not self._settings.upstox_analytics_token.strip():
            raise ProviderAuthenticationError(
                "Upstox Analytics Token is not configured. Market data operations cannot proceed."
            )

        async with self._instrument_lock:
            if self._instruments_loaded:
                return

            cached_master = self._cache.get("instrument_master")
            if cached_master is not None and isinstance(cached_master, list):
                self.load_instrument_master(cached_master)
                return

            url = self._settings.upstox_instrument_master_url
            client = await self._get_client()
            try:
                response = await client.get(url, timeout=self._settings.upstox_request_timeout_seconds)
                if response.status_code == 200:
                    content = response.content

                    # Handle gzip decompression (check gzip magic bytes b"\x1f\x8b" or .gz suffix)
                    if content.startswith(b"\x1f\x8b") or url.endswith(".gz"):
                        try:
                            decompressed = gzip.decompress(content)
                            text = decompressed.decode("utf-8")
                        except Exception as exc:
                            logger.error("Failed to decompress gzip instrument master: %s", exc)
                            raise MalformedDataError(f"Failed to decompress Upstox instrument master gzip: {exc}") from exc
                    else:
                        text = response.text

                    try:
                        data = json.loads(text)
                    except Exception as exc:
                        logger.error("Failed to parse instrument master JSON: %s", exc)
                        raise MalformedDataError(f"Failed to parse Upstox instrument master JSON: {exc}") from exc

                    if not isinstance(data, list):
                        raise MalformedDataError("Instrument master payload is not a list of instruments.")

                    count = self.load_instrument_master(data)
                    if count == 0:
                        raise MalformedDataError("No valid NSE equity instruments found in instrument master.")

                    self._cache.set(
                        "instrument_master",
                        data,
                        ttl_seconds=float(self._settings.upstox_instrument_master_ttl_seconds),
                    )
                    return
                else:
                    raise MarketDataUnavailableError(
                        f"Failed to download Upstox instrument master: HTTP {response.status_code}"
                    )
            except Exception as exc:
                if bool(self._symbol_to_instrument):
                    # Retain previous valid mapping and cache; do not wipe or corrupt state
                    self._instruments_loaded = True
                    logger.warning("Instrument master refresh failed (%s); retaining existing valid mappings.", exc)
                    return
                if isinstance(exc, (MalformedDataError, MarketDataUnavailableError, ProviderAuthenticationError)):
                    raise
                raise MarketDataUnavailableError(
                    f"Market data request failed due to connection error or timeout: {type(exc).__name__}"
                ) from exc
            finally:
                if self._client is None:
                    await client.aclose()

    def resolve_instrument_key(self, symbol: str, isin: str | None = None) -> str:
        """Resolve an NSE equity symbol to the Upstox instrument key.

        Validates symbol strictly against loaded instrument master.
        Optionally cross-checks with ISIN when provided.
        Raises InstrumentNotFoundError if missing or ambiguous.
        """
        if not symbol or not symbol.strip():
            raise InstrumentNotFoundError("", "Symbol cannot be empty.")

        norm_symbol = symbol.strip().upper()
        inst_key = self._symbol_to_instrument.get(norm_symbol)

        if not inst_key:
            raise InstrumentNotFoundError(
                norm_symbol,
                "Symbol is not registered in the Upstox NSE equity instrument master.",
            )

        if isin and isin.strip():
            norm_isin = isin.strip().upper()
            isin_key = self._isin_to_instrument.get(norm_isin)
            if isin_key is None or isin_key != inst_key:
                raise InstrumentNotFoundError(
                    norm_symbol,
                    f"Cross-check ISIN '{norm_isin}' does not match symbol '{norm_symbol}' (expected key '{inst_key}', got '{isin_key}').",
                )

        return inst_key

    def resolve_by_isin(self, isin: str) -> tuple[str, str] | None:
        """Resolve an ISIN to (canonical_trading_symbol, instrument_key).

        Returns None if the ISIN is unknown, missing, or cannot be mapped to an active NSE equity instrument.
        """
        if not isin or not isin.strip():
            return None
        norm_isin = isin.strip().upper()
        inst_key = self._isin_to_instrument.get(norm_isin)
        if not inst_key:
            return None
        symbol = self._instrument_to_symbol.get(inst_key)
        if not symbol:
            return None
        return symbol, inst_key

    async def get_instrument_identifier(self, symbol: str) -> str | None:
        """Resolve an exchange symbol to the provider instrument identifier (returns None if not resolvable)."""
        await self.ensure_instrument_master_loaded()
        try:
            return self.resolve_instrument_key(symbol)
        except InstrumentNotFoundError:
            return None

    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        """Fetch current reference price quote with timestamp and freshness verification."""
        await self.ensure_instrument_master_loaded()
        norm_symbol = symbol.strip().upper()
        instrument_key = self.resolve_instrument_key(norm_symbol)

        cache_key = f"quote:{norm_symbol}"

        async def _fetch_quote() -> tuple[MarketQuote, float, datetime | None]:
            headers = self._get_auth_headers()
            base_url = self._settings.upstox_api_base_url.rstrip("/")
            url = f"{base_url}/v3/market-quote/quotes"
            params = {"instrument_key": instrument_key}

            payload = await self._execute_with_retry("GET", url, headers=headers, params=params)

            data = payload.get("data")
            if not isinstance(data, dict):
                raise MalformedDataError(f"Missing 'data' dict in quote response for {norm_symbol}")

            # Locate quote dict: Upstox may key by 'NSE_EQ:RELIANCE' or 'NSE_EQ|INE...'
            quote_dict = data.get(instrument_key)
            if quote_dict is None:
                # Try finding by matching symbol or prefix
                for k, v in data.items():
                    if isinstance(v, dict):
                        v_symbol = v.get("symbol", "")
                        v_token = v.get("instrument_token", "")
                        if norm_symbol in k or norm_symbol in v_symbol or instrument_key == v_token:
                            quote_dict = v
                            break

            if not isinstance(quote_dict, dict):
                raise MalformedDataError(
                    f"Quote data for instrument '{norm_symbol}' ({instrument_key}) not found in response payload."
                )

            quote, ttl_seconds, last_trade_dt = self._parse_quote_payload(
                quote_dict=quote_dict,
                norm_symbol=norm_symbol,
                instrument_key=instrument_key,
                now_utc=datetime.now(timezone.utc),
            )
            return quote, ttl_seconds, last_trade_dt

        return await self._cache.get_or_compute(cache_key, _fetch_quote)

    def _parse_quote_payload(
        self,
        quote_dict: dict[str, Any],
        norm_symbol: str,
        instrument_key: str,
        now_utc: datetime,
    ) -> tuple[MarketQuote, float, datetime]:
        """Parse raw quote dict, assess freshness against market calendar, and return (MarketQuote, ttl, trade_dt)."""
        last_price_raw = quote_dict.get("last_price")
        if last_price_raw is None:
            raise MalformedDataError(f"Missing 'last_price' for {norm_symbol} quote.")

        try:
            last_price = Decimal(str(last_price_raw))
        except (InvalidOperation, ValueError, TypeError) as exc:
            raise MalformedDataError(f"Invalid 'last_price' value ({last_price_raw}) for {norm_symbol}.") from exc

        if last_price <= Decimal("0"):
            raise MalformedDataError(f"Non-positive 'last_price' ({last_price}) received for {norm_symbol}.")

        # 1. Authoritative Last Trade Time
        exchange_trade_time = quote_dict.get("last_trade_time")
        if exchange_trade_time is None:
            raise MalformedDataError(f"Missing required 'last_trade_time' in quote for {norm_symbol}.")

        last_trade_dt = parse_timestamp_safe(exchange_trade_time)
        if last_trade_dt is None:
            raise MalformedDataError(f"Malformed 'last_trade_time' value ({exchange_trade_time}) in quote for {norm_symbol}.")

        # 2. Provider Snapshot Generation Time
        snapshot_time = quote_dict.get("timestamp")
        snapshot_dt: datetime | None = None
        if snapshot_time is not None:
            snapshot_dt = parse_timestamp_safe(snapshot_time)
            if snapshot_dt is None:
                raise MalformedDataError(f"Malformed provider 'timestamp' value ({snapshot_time}) in quote for {norm_symbol}.")

        # 3. Assess Freshness based on Market Hours vs. Off-Market Policy
        in_market_hours = is_nse_market_hours(now_utc)
        is_stale = False

        if in_market_hours:
            market_hours_limit = float(self._settings.upstox_quote_market_hours_ttl_seconds)
            trade_age_seconds = (now_utc - last_trade_dt).total_seconds()

            if trade_age_seconds > market_hours_limit:
                is_stale = True
                logger.warning(
                    "Quote for %s is stale during market hours (last trade age: %.1f seconds > limit: %.1fs).",
                    norm_symbol,
                    trade_age_seconds,
                    market_hours_limit,
                )
            elif trade_age_seconds < -5.0:
                is_stale = True
                logger.warning(
                    "Quote for %s has future trade timestamp (%s vs local now %s).",
                    norm_symbol,
                    last_trade_dt,
                    now_utc,
                )

            if snapshot_dt is not None:
                provider_age_seconds = (now_utc - snapshot_dt).total_seconds()
                if provider_age_seconds > market_hours_limit or provider_age_seconds < -5.0:
                    is_stale = True
                    logger.warning(
                        "Quote for %s has stale provider response timestamp (provider age: %.1f seconds > limit: %.1fs).",
                        norm_symbol,
                        provider_age_seconds,
                        market_hours_limit,
                    )

            ttl_seconds = market_hours_limit
        else:
            latest_trading_day = self._calendar.get_latest_completed_trading_day(now_utc)
            trade_date_ist = last_trade_dt.astimezone(IST).date()

            if trade_date_ist < latest_trading_day:
                is_stale = True
                logger.warning(
                    "Quote for %s is stale off-market: last trade date %s is older than latest trading session %s.",
                    norm_symbol,
                    trade_date_ist,
                    latest_trading_day,
                )
            elif last_trade_dt > now_utc + timedelta(seconds=5):
                is_stale = True
                logger.warning(
                    "Quote for %s has future trade timestamp in off-market check (%s vs local now %s).",
                    norm_symbol,
                    last_trade_dt,
                    now_utc,
                )

            if snapshot_dt is not None and snapshot_dt > now_utc + timedelta(seconds=5):
                is_stale = True

            ttl_seconds = float(self._settings.upstox_quote_off_market_ttl_seconds)

        quote = MarketQuote(
            symbol=norm_symbol,
            instrument_identifier=instrument_key,
            last_price=last_price,
            timestamp=last_trade_dt,
            source="UPSTOX",
            is_stale=is_stale,
        )
        return quote, ttl_seconds, last_trade_dt

    async def get_reference_quotes_batch(
        self,
        symbols: list[str],
    ) -> dict[str, MarketQuote]:
        """Fetch current reference price quotes for multiple symbols with batching and cache reuse."""
        if not symbols:
            return {}

        await self.ensure_instrument_master_loaded()
        now_utc = datetime.now(timezone.utc)
        results: dict[str, MarketQuote] = {}
        symbols_to_fetch: list[str] = []
        key_to_symbol: dict[str, str] = {}

        for sym in symbols:
            norm_sym = sym.strip().upper()
            cache_key = f"quote:{norm_sym}"
            cached_quote = self._cache.get(cache_key, now=now_utc)
            if cached_quote is not None and isinstance(cached_quote, MarketQuote):
                in_market = is_nse_market_hours(now_utc)
                if in_market:
                    market_limit = float(self._settings.upstox_quote_market_hours_ttl_seconds)
                    trade_age = (now_utc - cached_quote.timestamp).total_seconds()
                    if -5.0 <= trade_age <= market_limit:
                        results[norm_sym] = cached_quote
                        continue
                else:
                    latest_day = self._calendar.get_latest_completed_trading_day(now_utc)
                    trade_date = cached_quote.timestamp.astimezone(IST).date()
                    if trade_date >= latest_day and cached_quote.timestamp <= now_utc + timedelta(seconds=5):
                        results[norm_sym] = cached_quote
                        continue

            try:
                inst_key = self.resolve_instrument_key(norm_sym)
                key_to_symbol[inst_key] = norm_sym
                symbols_to_fetch.append(norm_sym)
            except InstrumentNotFoundError:
                logger.warning("Symbol %s not found in instrument master during batch quote lookup.", norm_sym)

        if not key_to_symbol:
            return results

        # Upstox V3 supports comma-separated instrument keys in batch requests (up to 100 instruments)
        batch_size = 50
        keys_list = list(key_to_symbol.keys())
        headers = self._get_auth_headers()
        base_url = self._settings.upstox_api_base_url.rstrip("/")
        url = f"{base_url}/v3/market-quote/quotes"

        for i in range(0, len(keys_list), batch_size):
            chunk_keys = keys_list[i : i + batch_size]
            params = {"instrument_key": ",".join(chunk_keys)}

            try:
                payload = await self._execute_with_retry("GET", url, headers=headers, params=params)
                data = payload.get("data")
                if not isinstance(data, dict):
                    continue

                for inst_key in chunk_keys:
                    sym = key_to_symbol[inst_key]
                    quote_dict = data.get(inst_key)
                    if quote_dict is None:
                        for k, v in data.items():
                            if isinstance(v, dict):
                                if sym in k or sym in v.get("symbol", "") or inst_key == v.get("instrument_token", ""):
                                    quote_dict = v
                                    break

                    if not isinstance(quote_dict, dict):
                        continue

                    try:
                        quote, ttl_sec, trade_dt = self._parse_quote_payload(
                            quote_dict=quote_dict,
                            norm_symbol=sym,
                            instrument_key=inst_key,
                            now_utc=now_utc,
                        )
                        self._cache.set(f"quote:{sym}", quote, ttl_sec, source_timestamp=trade_dt, now=now_utc)
                        results[sym] = quote
                    except MalformedDataError as exc:
                        logger.warning("Failed to parse quote for %s in batch: %s", sym, exc)
            except (ProviderAuthenticationError, RateLimitExceededError):
                raise
            except Exception as exc:
                logger.warning("Batch quote request failed for chunk %d-%d: %s", i, i + len(chunk_keys), exc)

        return results

    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        """Fetch historical weekly candles in ascending chronological order."""
        await self.ensure_instrument_master_loaded()
        norm_symbol = symbol.strip().upper()
        instrument_key = self.resolve_instrument_key(norm_symbol)

        cache_key = f"candles:{norm_symbol}:{limit_weeks}"

        async def _fetch_candles() -> tuple[list[WeeklyCandle], float, datetime | None]:
            headers = self._get_auth_headers()
            base_url = self._settings.upstox_api_base_url.rstrip("/")

            # Calculate date range: Upstox V3 historical candle endpoint format:
            # /v3/historical-candle/{instrument_key}/weeks/1/{to_date}/{from_date}
            # Buffer limit_weeks * 7 days + 90 days buffer to guarantee retrieving requested count
            today = datetime.now(timezone.utc).astimezone(IST).date()
            from_date = today - timedelta(days=(limit_weeks * 7 + 90))

            to_date_str = today.isoformat()
            from_date_str = from_date.isoformat()

            # Upstox V3 endpoint: /v3/historical-candle/{instrument_key}/weeks/1/{to_date}/{from_date}
            url = f"{base_url}/v3/historical-candle/{instrument_key}/weeks/1/{to_date_str}/{from_date_str}"

            payload = await self._execute_with_retry("GET", url, headers=headers)

            data = payload.get("data")
            if not isinstance(data, dict):
                raise MalformedDataError(f"Missing 'data' dict in historical candle response for {norm_symbol}")

            raw_candles = data.get("candles")
            if not isinstance(raw_candles, list):
                raise MalformedDataError(f"Missing 'candles' array in historical candle response for {norm_symbol}")

            candles: list[WeeklyCandle] = []
            now_ist = datetime.now(timezone.utc).astimezone(IST)

            for idx, item in enumerate(raw_candles):
                # Expected format: [timestamp, open, high, low, close, volume, open_interest]
                if not isinstance(item, (list, tuple)) or len(item) < 6:
                    raise MalformedDataError(
                        f"Candle row at index {idx} has invalid format: {item}"
                    )

                ts_raw, open_raw, high_raw, low_raw, close_raw, vol_raw = item[:6]

                try:
                    open_price = Decimal(str(open_raw))
                    high_price = Decimal(str(high_raw))
                    low_price = Decimal(str(low_raw))
                    close_price = Decimal(str(close_raw))
                    volume = int(vol_raw)
                except (InvalidOperation, ValueError, TypeError) as exc:
                    raise MalformedDataError(
                        f"Invalid numeric values in candle row {idx}: {exc}"
                    ) from exc

                # Parse candle date
                candle_ts = parse_timestamp_safe(ts_raw)
                if candle_ts is None:
                    raise MalformedDataError(f"Invalid timestamp in candle row {idx}: {ts_raw}")
                raw_candle_date = candle_ts.astimezone(IST).date()

                # Basic bar sanity
                if open_price <= 0 or high_price <= 0 or low_price <= 0 or close_price <= 0:
                    raise MalformedDataError(f"Non-positive prices in candle row {idx}")
                if high_price < low_price or high_price < open_price or high_price < close_price:
                    raise MalformedDataError(f"Inconsistent high/low prices in candle row {idx}")
                if low_price > open_price or low_price > close_price:
                    raise MalformedDataError(f"Inconsistent low price in candle row {idx}")
                if volume < 0:
                    raise MalformedDataError(f"Negative volume in candle row {idx}")

                # Resolve weekly closing session date and completion status via NSETradingCalendar
                # Handles start-of-week timestamps (Monday), Friday holidays, and shortened weeks
                closing_session_date = self._calendar.get_weekly_closing_date(raw_candle_date)
                is_completed = self._calendar.is_week_completed(raw_candle_date, now=now_ist)

                candles.append(
                    WeeklyCandle(
                        symbol=norm_symbol,
                        candle_date=closing_session_date,
                        open_price=open_price,
                        high_price=high_price,
                        low_price=low_price,
                        close_price=close_price,
                        volume=volume,
                        is_completed=is_completed,
                    )
                )

            # Sort strictly ascending chronologically by candle_date
            candles.sort(key=lambda c: c.candle_date)

            ttl_seconds = float(self._settings.upstox_weekly_candle_ttl_seconds)
            source_timestamp = datetime.now(timezone.utc)
            return candles, ttl_seconds, source_timestamp

        return await self._cache.get_or_compute(cache_key, _fetch_candles)
