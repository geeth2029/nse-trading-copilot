"""Market data provider factory for configuring TejHQ or Upstox providers."""

from collections.abc import Callable
from datetime import datetime

import httpx

from app.core.config import Settings
from app.services.market_data.base import MarketDataProvider
from app.services.market_data.calendar import NSETradingCalendar
from app.services.market_data.tej import TejMarketDataProvider
from app.services.market_data.upstox import UpstoxMarketDataProvider


def create_market_data_provider(
    settings: Settings,
    client: httpx.AsyncClient | None = None,
    calendar: NSETradingCalendar | None = None,
    clock: Callable[[], datetime] | None = None,
) -> MarketDataProvider:
    """Create and return the configured MarketDataProvider instance based on application settings.

    Supported provider keys:
    - 'tej': TejHQ Free End-of-Day Hugging Face Parquet mirror (zero broker/API key requirement).
    - 'upstox': Upstox v3 API adapter (requires Upstox analytics token).
    """
    provider_type = (settings.market_data_provider or "tej").strip().lower()

    if provider_type == "upstox":
        return UpstoxMarketDataProvider(
            settings=settings,
            client=client,
            calendar=calendar,
        )

    # Default to TejHQ for free, open end-of-day market data
    return TejMarketDataProvider(
        settings=settings,
        calendar=calendar,
        client=client,
        clock=clock,
    )
