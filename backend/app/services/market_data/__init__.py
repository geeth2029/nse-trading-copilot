"""Market data service package for verified NSE market quotes and indicator calculations."""

from app.services.market_data.base import (
    MarketDataProvider,
    MarketQuote,
    TechnicalIndicators,
    WeeklyCandle,
)
from app.services.market_data.cache import CacheEntry, MarketDataCache
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MalformedDataError,
    MarketDataError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
    StaleDataError,
)
from app.services.market_data.calendar import NSETradingCalendar, VERIFIED_NSE_HOLIDAYS
from app.services.market_data.indicators import (
    InsufficientHistoryError,
    InvalidCandleDataError,
    calculate_technical_indicators,
    calculate_twenty_week_sma,
    calculate_wilders_rsi,
    validate_and_prepare_candles,
)
from app.services.market_data.service import (
    MarketDataService,
    MarketSnapshot,
    derive_initial_entry,
    derive_pyramid_entry,
)
from app.services.market_data.factory import create_market_data_provider
from app.services.market_data.tej import (
    DailyEquityRecord,
    DailyToWeeklyCandleAggregator,
    TejMarketDataProvider,
)
from app.services.market_data.upstox import UpstoxMarketDataProvider

__all__ = [
    "MarketDataProvider",
    "MarketQuote",
    "TechnicalIndicators",
    "WeeklyCandle",
    "CacheEntry",
    "MarketDataCache",
    "NSETradingCalendar",
    "VERIFIED_NSE_HOLIDAYS",
    "MarketDataService",
    "MarketSnapshot",
    "derive_initial_entry",
    "derive_pyramid_entry",
    "MarketDataError",
    "ProviderAuthenticationError",
    "RateLimitExceededError",
    "InstrumentNotFoundError",
    "MarketDataUnavailableError",
    "MalformedDataError",
    "StaleDataError",
    "InsufficientHistoryError",
    "InvalidCandleDataError",
    "calculate_technical_indicators",
    "calculate_twenty_week_sma",
    "calculate_wilders_rsi",
    "validate_and_prepare_candles",
    "UpstoxMarketDataProvider",
    "TejMarketDataProvider",
    "DailyEquityRecord",
    "DailyToWeeklyCandleAggregator",
    "create_market_data_provider",
]
