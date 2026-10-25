from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class MarketQuote:
    """Represents a current equity reference quote snapshot."""

    symbol: str
    instrument_identifier: str
    last_price: Decimal
    timestamp: datetime  # Timezone-aware timestamp
    source: str = "UPSTOX"
    is_stale: bool = False


@dataclass(frozen=True, slots=True)
class WeeklyCandle:
    """Represents an OHLCV weekly bar for an equity instrument."""

    symbol: str
    candle_date: date  # Closing session date of the weekly candle
    open_price: Decimal
    high_price: Decimal
    low_price: Decimal
    close_price: Decimal
    volume: int
    is_completed: bool = True  # True only if the weekly session is closed


@dataclass(frozen=True, slots=True)
class TechnicalIndicators:
    """Technical indicators derived strictly from completed weekly candle history."""

    symbol: str
    latest_completed_candle_date: date | None
    twenty_week_sma: Decimal | None
    weekly_rsi: Decimal | None
    completed_candles_count: int
    is_valid: bool
    status_reason: str | None = None


class MarketDataProvider(ABC):
    """Abstract interface decoupling trading rules from market data providers."""

    @abstractmethod
    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        """Fetch current reference price quote with timestamp and freshness status."""
        pass

    @abstractmethod
    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        """Fetch historical weekly candles in chronological order."""
        pass

    @abstractmethod
    async def get_instrument_identifier(self, symbol: str) -> str | None:
        """Resolve an exchange symbol (e.g. 'RELIANCE') to the provider instrument identifier."""
        pass

    async def get_reference_quotes_batch(
        self,
        symbols: list[str],
    ) -> dict[str, MarketQuote]:
        """Fetch current reference price quotes for multiple symbols.

        Default implementation retrieves quotes individually. Providers may
        override this with an optimized batch query where supported.
        """
        results: dict[str, MarketQuote] = {}
        for sym in symbols:
            try:
                results[sym] = await self.get_reference_quote(sym)
            except Exception:
                pass
        return results

