"""Pydantic schemas for market data snapshots and indicators."""

from datetime import date, datetime

from app.schemas.base import APIModel


class MarketSnapshotRead(APIModel):
    """Authoritative market data snapshot containing price and completed weekly indicators."""

    symbol: str
    instrument_identifier: str
    last_price: float
    quote_timestamp: datetime
    twenty_week_sma: float | None = None
    weekly_rsi: float | None = None
    latest_completed_candle_date: date | None = None
    completed_candles_count: int
    is_stale: bool
    is_eligible_for_initial: bool
    status_reason: str | None = None
    source: str = "UPSTOX"
