"""Bulk market-data screening service for verified NSE Large-Cap Universe constituents."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import logging
from typing import Any

from app.core.config import Settings
from app.schemas.universe import (
    ConstituentScreenResultRead,
    LargeCapUniverse,
    UniverseConstituent,
    UniverseScreenResponse,
    UniverseStatusRead,
)
from app.services.market_data.base import (
    MarketDataProvider,
    MarketQuote,
    TechnicalIndicators,
)
from app.services.market_data.cache import MarketDataCache
from app.services.market_data.calendar import IST, NSETradingCalendar
from app.services.market_data.errors import (
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
)
from app.services.market_data.indicators import calculate_technical_indicators
from app.services.market_data.universe_service import (
    UniverseNotAvailableError,
    UniverseService,
)
from app.services.market_data.upstox import is_nse_market_hours

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ConstituentScreenResult:
    """Internal domain model for constituent screening result."""

    rank: int
    company_name: str
    isin: str
    canonical_nse_symbol: str
    upstox_instrument_key: str
    last_price: Decimal | None
    quote_timestamp: datetime | None
    twenty_week_sma: Decimal | None
    weekly_rsi: Decimal | None
    latest_completed_candle_date: date | None
    is_stale: bool
    is_qualified: bool
    diagnostic_status: str
    diagnostic_reason: str | None


def to_read_model(r: ConstituentScreenResult) -> ConstituentScreenResultRead:
    """Convert internal screening result to public camelCase API read schema."""
    return ConstituentScreenResultRead(
        rank=r.rank,
        company_name=r.company_name,
        isin=r.isin,
        canonical_nse_symbol=r.canonical_nse_symbol,
        upstox_instrument_key=r.upstox_instrument_key,
        last_price=float(r.last_price) if r.last_price is not None else None,
        quote_timestamp=r.quote_timestamp,
        twenty_week_sma=float(r.twenty_week_sma) if r.twenty_week_sma is not None else None,
        weekly_rsi=float(r.weekly_rsi) if r.weekly_rsi is not None else None,
        latest_completed_candle_date=r.latest_completed_candle_date,
        is_stale=r.is_stale,
        is_qualified=r.is_qualified,
        diagnostic_status=r.diagnostic_status,
        diagnostic_reason=r.diagnostic_reason,
    )


class UniverseScreenerService:
    """Coordinates universe retrieval, batch quote fetching, bounded weekly candle retrieval,

    and technical indicator evaluation to produce authoritative screening results for the
    NSE Large-Cap Universe.
    """

    def __init__(
        self,
        universe_service: UniverseService,
        provider: MarketDataProvider,
        settings: Settings | None = None,
        clock: Callable[[], datetime] | None = None,
        concurrency_limit: int = 10,
        calendar: NSETradingCalendar | None = None,
        indicator_cache: MarketDataCache | None = None,
        screener_cache: MarketDataCache | None = None,
    ) -> None:
        self._universe_service = universe_service
        self._provider = provider
        self._settings = settings or Settings.from_environment()
        self._clock = clock
        self._concurrency_limit = max(1, concurrency_limit)
        self._calendar = calendar or NSETradingCalendar()
        self._indicator_cache = indicator_cache or MarketDataCache()
        self._screener_cache = screener_cache or MarketDataCache()

    def _get_now(self) -> datetime:
        """Resolve current UTC timestamp using injected clock or system time."""
        if self._clock is not None:
            return self._clock()
        return datetime.now(timezone.utc)

    def _get_provider_code(self) -> str:
        """Resolve active market data provider code (e.g. 'TEJHQ', 'UPSTOX')."""
        from app.services.market_data.tej import TejMarketDataProvider
        return "TEJHQ" if isinstance(self._provider, TejMarketDataProvider) else "UPSTOX"

    def _is_quote_fresh(
        self,
        quote_timestamp: datetime | None,
        now_utc: datetime,
        source: str | None = None,
    ) -> bool:
        """Check whether a quote timestamp remains fresh according to NSE market hours policy."""
        if quote_timestamp is None:
            return False

        if source == "TEJHQ":
            latest_trading_day = self._calendar.get_latest_completed_trading_day(now_utc)
            trade_date_ist = quote_timestamp.astimezone(IST).date()
            return trade_date_ist >= latest_trading_day and quote_timestamp <= now_utc + timedelta(seconds=5)

        if is_nse_market_hours(now_utc):
            market_hours_limit = float(self._settings.upstox_quote_market_hours_ttl_seconds)
            age_seconds = (now_utc - quote_timestamp).total_seconds()
            return -5.0 <= age_seconds <= market_hours_limit
        else:
            latest_trading_day = self._calendar.get_latest_completed_trading_day(now_utc)
            trade_date_ist = quote_timestamp.astimezone(IST).date()
            return trade_date_ist >= latest_trading_day and quote_timestamp <= now_utc + timedelta(seconds=5)

    async def screen_universe(
        self,
        as_of_date: date | None = None,
        qualified_only: bool = False,
        force_refresh: bool = False,
    ) -> UniverseScreenResponse:
        """Execute full screening against the active large-cap universe.

        Enforces:
        - Strict universe validity: refuses to screen if universe is missing, invalid,
          expired, or not yet active.
        - Batch quote retrieval with cache reuse.
        - Bounded concurrent historical weekly candle retrieval.
        - Deterministic indicator calculations (Wilder's RSI 14, SMA 20).
        - Qualification policy: Weekly RSI > 60 with fresh, non-stale market data.
        - Preserves rank order 1 to 100.
        """
        now_utc = self._get_now()
        eval_date = as_of_date or now_utc.date()

        # 1. Obtain and validate large-cap universe status
        u_status = self._universe_service.get_status(as_of_date=eval_date)
        if u_status.status != "VALID":
            raise UniverseNotAvailableError(u_status)

        constituents = self._universe_service.get_constituents(as_of_date=eval_date)
        if not constituents:
            raise UniverseNotAvailableError(u_status)

        # 2. Check screener-level cache
        cache_key = f"universe_screen:{u_status.dataset_version}:{eval_date.isoformat()}"
        cached_results: list[ConstituentScreenResult] | None = None

        if not force_refresh:
            cached_data = self._screener_cache.get(cache_key, now=now_utc)
            if cached_data is not None and isinstance(cached_data, list):
                cached_results = cached_data

        if cached_results is not None:
            # Re-evaluate quote freshness for every constituent before serving cached results
            refreshed_results: list[ConstituentScreenResult] = []
            for item in cached_results:
                is_stale_now = item.is_stale or (
                    item.quote_timestamp is not None and not self._is_quote_fresh(item.quote_timestamp, now_utc)
                )
                if is_stale_now:
                    refreshed_results.append(
                        replace(
                            item,
                            is_stale=True,
                            is_qualified=False,
                            diagnostic_status="STALE_QUOTE",
                            diagnostic_reason="Market quote has expired and is stale; fresh quote required.",
                        )
                    )
                else:
                    refreshed_results.append(item)

            qualified_count = sum(1 for r in refreshed_results if r.is_qualified)
            displayed_results = (
                [r for r in refreshed_results if r.is_qualified] if qualified_only else refreshed_results
            )

            return UniverseScreenResponse(
                universe_version=u_status.dataset_version or "UNKNOWN",
                classification_period=u_status.classification_period or "UNKNOWN",
                source_period_label=u_status.source_period_label,
                evaluated_at=now_utc,
                total_constituents=len(constituents),
                qualified_count=qualified_count,
                results=[to_read_model(r) for r in displayed_results],
                market_data_source=self._get_provider_code(),
            )

        # 3. Perform live screening evaluation
        symbols = [c.canonical_nse_symbol for c in constituents]

        # A. Batch quote fetch
        try:
            quotes = await self._provider.get_reference_quotes_batch(symbols)
        except (ProviderAuthenticationError, RateLimitExceededError, MarketDataUnavailableError):
            raise
        except Exception as exc:
            logger.error("Failed to retrieve batch quotes: %s", exc)
            quotes = {}

        if not quotes and constituents:
            raise MarketDataUnavailableError(
                "Market data is currently unavailable from provider for universe constituents."
            )

        # B. Bounded concurrent weekly candle fetch and indicator derivation
        semaphore = asyncio.Semaphore(self._concurrency_limit)

        async def _fetch_indicators(symbol: str) -> tuple[TechnicalIndicators | None, str | None]:
            async with semaphore:
                ind_cache_key = f"indicators:{symbol}"
                cached_ind = self._indicator_cache.get(ind_cache_key, now=now_utc)
                if cached_ind is not None and isinstance(cached_ind, TechnicalIndicators):
                    return cached_ind, None

                try:
                    candles = await self._provider.get_historical_weekly_candles(symbol, limit_weeks=100)
                    indicators = calculate_technical_indicators(symbol, candles)
                    if indicators.is_valid:
                        # Indicators from completed weekly candles are cached with long TTL
                        candle_ttl = float(self._settings.upstox_weekly_candle_ttl_seconds)
                        self._indicator_cache.set(ind_cache_key, indicators, ttl_seconds=candle_ttl, now=now_utc)
                    return indicators, None
                except Exception as exc:
                    logger.warning("Historical weekly candle fetch failed for %s: %s", symbol, exc)
                    return None, "PROVIDER_ERROR"

        indicator_tasks = [_fetch_indicators(sym) for sym in symbols]
        indicator_results = await asyncio.gather(*indicator_tasks)
        indicator_map = dict(zip(symbols, indicator_results))

        # C. Evaluate each constituent strictly against established trading rules
        results: list[ConstituentScreenResult] = []

        for c in constituents:
            sym = c.canonical_nse_symbol
            quote: MarketQuote | None = quotes.get(sym)
            indicators, ind_err = indicator_map.get(sym, (None, "PROVIDER_ERROR"))

            is_qualified = False
            diag_status: str
            diag_reason: str | None

            quote_is_stale = (
                quote.is_stale or not self._is_quote_fresh(quote.timestamp, now_utc, source=quote.source)
            ) if quote else False

            if ind_err == "PROVIDER_ERROR":
                diag_status = "PROVIDER_ERROR"
                diag_reason = "Market data provider error retrieving historical candle data."
            elif quote is None:
                diag_status = "QUOTE_UNAVAILABLE"
                diag_reason = "Current market quote is unavailable from provider."
            elif quote_is_stale:
                diag_status = "STALE_QUOTE"
                diag_reason = "Market quote is stale; trading qualification requires verified fresh quotes."
            elif indicators is None or indicators.completed_candles_count < 20:
                diag_status = "INSUFFICIENT_HISTORY"
                count = indicators.completed_candles_count if indicators else 0
                diag_reason = (
                    f"Insufficient completed weekly candles ({count}/20 required for SMA, {count}/50 required for RSI)."
                )
            elif indicators.completed_candles_count < 50:
                diag_status = "INSUFFICIENT_HISTORY"
                count = indicators.completed_candles_count
                diag_reason = (
                    f"Insufficient completed weekly candles for RSI ({count}/50 required). 20-week SMA is available."
                )
            elif indicators.weekly_rsi is None:
                diag_status = "INDICATORS_UNAVAILABLE"
                diag_reason = indicators.status_reason or "Weekly RSI indicator is unavailable from candle history."
            elif indicators.twenty_week_sma is None:
                diag_status = "INDICATORS_UNAVAILABLE"
                diag_reason = indicators.status_reason or "20-week SMA indicator is unavailable from candle history."
            elif indicators.weekly_rsi <= Decimal("60"):
                diag_status = "NOT_QUALIFIED"
                diag_reason = f"Weekly RSI ({indicators.weekly_rsi}) is not strictly greater than 60."
            else:
                is_qualified = True
                diag_status = "QUALIFIED"
                diag_reason = f"Qualified: Weekly RSI ({indicators.weekly_rsi}) is strictly greater than 60 with verified fresh market data."

            result_item = ConstituentScreenResult(
                rank=c.rank,
                company_name=c.company_name,
                isin=c.isin,
                canonical_nse_symbol=c.canonical_nse_symbol,
                upstox_instrument_key=c.upstox_instrument_key,
                last_price=quote.last_price if quote else None,
                quote_timestamp=quote.timestamp if quote else None,
                twenty_week_sma=indicators.twenty_week_sma if indicators else None,
                weekly_rsi=indicators.weekly_rsi if indicators else None,
                latest_completed_candle_date=indicators.latest_completed_candle_date if indicators else None,
                is_stale=quote_is_stale,
                is_qualified=is_qualified,
                diagnostic_status=diag_status,
                diagnostic_reason=diag_reason,
            )
            results.append(result_item)

        # Sort strictly by large-cap rank ascending (1 to 100)
        results.sort(key=lambda r: r.rank)

        # Cache complete screen results; underlying quote timestamps will be re-evaluated
        # against freshness rules on every cache hit
        cache_ttl = max(300.0, float(self._settings.upstox_quote_market_hours_ttl_seconds) * 5)
        self._screener_cache.set(cache_key, results, ttl_seconds=cache_ttl, now=now_utc)

        qualified_count = sum(1 for r in results if r.is_qualified)
        displayed_results = [r for r in results if r.is_qualified] if qualified_only else results

        return UniverseScreenResponse(
            universe_version=u_status.dataset_version or "UNKNOWN",
            classification_period=u_status.classification_period or "UNKNOWN",
            source_period_label=u_status.source_period_label,
            evaluated_at=now_utc,
            total_constituents=len(constituents),
            qualified_count=qualified_count,
            results=[to_read_model(r) for r in displayed_results],
            market_data_source=self._get_provider_code(),
        )
