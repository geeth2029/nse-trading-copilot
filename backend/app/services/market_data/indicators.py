"""Pure technical-indicator calculation engine for verified market data.

Provides mathematically deterministic, precision-checked calculations for:
1. 20-week Simple Moving Average (SMA) from completed weekly candles.
2. 14-period Wilder's Smoothed Relative Strength Index (RSI) from completed weekly candles.
3. Input validation, OHLC sanity enforcement, and incomplete candle filtering.

Numerical Precision & Rounding Policy:
- All financial prices, price differences, and sums are maintained as Python `Decimal` objects.
- 20-week SMA is quantized to paise precision (`Decimal("0.01")`) using `ROUND_HALF_UP`.
- Weekly RSI is maintained with high precision (`Decimal("0.0001")`, four decimal places)
  using `ROUND_HALF_UP` to prevent premature truncation before strict threshold evaluation
  (`weekly_rsi > Decimal("60.0")`).
"""

from collections.abc import Sequence
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from app.services.market_data.base import TechnicalIndicators, WeeklyCandle

CENT = Decimal("0.01")
RSI_PRECISION = Decimal("0.0001")
DEFAULT_SMA_PERIOD = 20
DEFAULT_RSI_PERIOD = 14
DEFAULT_RSI_MIN_CANDLES = 50


class InvalidCandleDataError(ValueError):
    """Raised when candle data contains malformed, negative, or contradictory OHLC values."""
    pass


class InsufficientHistoryError(ValueError):
    """Raised when insufficient completed candles exist for a required indicator lookback."""
    pass


def validate_and_prepare_candles(
    candles: Sequence[WeeklyCandle],
) -> list[WeeklyCandle]:
    """Validates weekly candles, excludes uncompleted ones, and sorts chronologically.

    Enforces:
    - Exclusion of candles marked is_completed=False.
    - Prices must be strictly positive (Open, High, Low, Close > 0).
    - High >= Low.
    - High >= Open and High >= Close.
    - Low <= Open and Low <= Close.
    - Volume >= 0.
    - No duplicate candle dates.
    - Sorted chronologically ascending by candle_date.

    Raises:
        InvalidCandleDataError: If any completed candle violates OHLC relationships or dates duplicate.
    """
    completed = [c for c in candles if c.is_completed]
    if not completed:
        return []

    seen_dates: set[date] = set()

    for c in completed:
        # Check for non-finite or non-positive values
        if (
            c.open_price <= 0
            or c.high_price <= 0
            or c.low_price <= 0
            or c.close_price <= 0
        ):
            raise InvalidCandleDataError(
                f"Candle for {c.symbol} on {c.candle_date} has non-positive prices: "
                f"O={c.open_price}, H={c.high_price}, L={c.low_price}, C={c.close_price}"
            )

        # Check volume
        if c.volume < 0:
            raise InvalidCandleDataError(
                f"Candle for {c.symbol} on {c.candle_date} has negative volume: {c.volume}"
            )

        # Check OHLC internal consistency
        if c.high_price < c.low_price:
            raise InvalidCandleDataError(
                f"Candle for {c.symbol} on {c.candle_date} has High ({c.high_price}) < Low ({c.low_price})"
            )
        if c.high_price < c.open_price or c.high_price < c.close_price:
            raise InvalidCandleDataError(
                f"Candle for {c.symbol} on {c.candle_date} has High ({c.high_price}) less than Open ({c.open_price}) or Close ({c.close_price})"
            )
        if c.low_price > c.open_price or c.low_price > c.close_price:
            raise InvalidCandleDataError(
                f"Candle for {c.symbol} on {c.candle_date} has Low ({c.low_price}) greater than Open ({c.open_price}) or Close ({c.close_price})"
            )

        # Check for duplicate dates
        if c.candle_date in seen_dates:
            raise InvalidCandleDataError(
                f"Duplicate candle date detected for {c.symbol}: {c.candle_date}"
            )
        seen_dates.add(c.candle_date)

    return sorted(completed, key=lambda x: x.candle_date)


def calculate_twenty_week_sma(
    candles: Sequence[WeeklyCandle],
    *,
    period: int = DEFAULT_SMA_PERIOD,
    precision: Decimal = CENT,
) -> Decimal | None:
    """Calculates the Simple Moving Average of the last N completed weekly closing prices.

    Args:
        candles: Sequence of weekly candles (may include uncompleted or unsorted bars).
        period: Lookback window (strictly 20 for trading rules).
        precision: Quantization precision for Decimal output.

    Returns:
        Decimal SMA value quantized to precision, or None if fewer than `period` completed candles exist.
    """
    sorted_candles = validate_and_prepare_candles(candles)
    if len(sorted_candles) < period:
        return None

    recent_window = sorted_candles[-period:]
    total_closes = sum((c.close_price for c in recent_window), start=Decimal("0"))
    sma = total_closes / Decimal(period)
    return sma.quantize(precision, rounding=ROUND_HALF_UP)


def calculate_wilders_rsi(
    candles: Sequence[WeeklyCandle],
    *,
    period: int = DEFAULT_RSI_PERIOD,
    min_candles: int = DEFAULT_RSI_MIN_CANDLES,
    precision: Decimal = RSI_PRECISION,
) -> Decimal | None:
    """Calculates 14-period Wilder's Smoothed RSI from completed weekly closing prices.

    Wilder's RSI Smoothing Formula:
    1. First `period` price changes:
       avg_gain_0 = sum(gains_1..period) / period
       avg_loss_0 = sum(losses_1..period) / period
    2. Subsequent changes t from (period + 1) to M:
       avg_gain_t = (avg_gain_(t-1) * (period - 1) + gain_t) / period
       avg_loss_t = (avg_loss_(t-1) * (period - 1) + loss_t) / period
    3. Final RSI:
       - If avg_gain == 0 and avg_loss == 0: RSI = 50.0
       - If avg_loss == 0 and avg_gain > 0: RSI = 100.0
       - If avg_gain == 0 and avg_loss > 0: RSI = 0.0
       - Otherwise: RS = avg_gain / avg_loss, RSI = 100 - (100 / (1 + RS))
                   (Equivalent to: (100 * avg_gain) / (avg_gain + avg_loss))

    Lookback & Precision Policy:
    - Requires at least `min_candles` (strictly >= 50) completed candles to ensure
      exponential decay eliminates seed initialization bias.
    - Returned Decimal is quantized to `precision` (default 4 decimal places) without
      coarse integer rounding, preserving strict evaluation for rules like `RSI > 60.0`.

    Args:
        candles: Sequence of weekly candles.
        period: Smoothing period (default 14).
        min_candles: Minimum completed candles required (default 50).
        precision: Decimal quantization precision (default 0.0001).

    Returns:
        Decimal RSI value between 0.0 and 100.0, or None if history is insufficient.
    """
    sorted_candles = validate_and_prepare_candles(candles)
    if len(sorted_candles) < min_candles:
        return None

    closes = [c.close_price for c in sorted_candles]
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

    # Initial seed window (first `period` changes)
    initial_changes = deltas[:period]
    avg_gain = sum(
        (max(d, Decimal("0")) for d in initial_changes),
        start=Decimal("0"),
    ) / Decimal(period)
    avg_loss = sum(
        (max(-d, Decimal("0")) for d in initial_changes),
        start=Decimal("0"),
    ) / Decimal(period)

    # Wilder's smoothing for subsequent changes
    period_minus_one = Decimal(period - 1)
    period_dec = Decimal(period)

    for delta in deltas[period:]:
        gain = max(delta, Decimal("0"))
        loss = max(-delta, Decimal("0"))
        avg_gain = (avg_gain * period_minus_one + gain) / period_dec
        avg_loss = (avg_loss * period_minus_one + loss) / period_dec

    # Edge cases
    if avg_gain == Decimal("0") and avg_loss == Decimal("0"):
        return Decimal("50.0").quantize(precision, rounding=ROUND_HALF_UP)
    if avg_loss == Decimal("0"):
        return Decimal("100.0").quantize(precision, rounding=ROUND_HALF_UP)
    if avg_gain == Decimal("0"):
        return Decimal("0.0").quantize(precision, rounding=ROUND_HALF_UP)

    # Standard formula: 100 * avg_gain / (avg_gain + avg_loss)
    rsi = (Decimal("100") * avg_gain) / (avg_gain + avg_loss)
    return rsi.quantize(precision, rounding=ROUND_HALF_UP)


def calculate_technical_indicators(
    symbol: str,
    candles: Sequence[WeeklyCandle],
) -> TechnicalIndicators:
    """Calculates all strategy technical indicators for an instrument.

    Validates inputs and determines if the instrument satisfies history requirements:
    - SMA requires >= 20 completed candles.
    - RSI requires >= 50 completed candles.
    - is_valid is True only when BOTH SMA and RSI are available with valid history.

    Args:
        symbol: Instrument symbol (e.g. 'INFY').
        candles: Sequence of weekly candles.

    Returns:
        TechnicalIndicators instance with indicators or explicit unavailability reasons.
    """
    sorted_candles = validate_and_prepare_candles(candles)
    count = len(sorted_candles)

    if count == 0:
        return TechnicalIndicators(
            symbol=symbol,
            latest_completed_candle_date=None,
            twenty_week_sma=None,
            weekly_rsi=None,
            completed_candles_count=0,
            is_valid=False,
            status_reason="No completed weekly candles available.",
        )

    latest_date = sorted_candles[-1].candle_date
    sma = calculate_twenty_week_sma(sorted_candles)
    rsi = calculate_wilders_rsi(sorted_candles)

    if count < DEFAULT_SMA_PERIOD:
        return TechnicalIndicators(
            symbol=symbol,
            latest_completed_candle_date=latest_date,
            twenty_week_sma=None,
            weekly_rsi=None,
            completed_candles_count=count,
            is_valid=False,
            status_reason=(
                f"Insufficient completed weekly candles ({count}/{DEFAULT_SMA_PERIOD} "
                f"required for SMA, {count}/{DEFAULT_RSI_MIN_CANDLES} required for RSI)."
            ),
        )

    if count < DEFAULT_RSI_MIN_CANDLES:
        return TechnicalIndicators(
            symbol=symbol,
            latest_completed_candle_date=latest_date,
            twenty_week_sma=sma,
            weekly_rsi=None,
            completed_candles_count=count,
            is_valid=False,
            status_reason=(
                f"Insufficient completed weekly candles for RSI ({count}/{DEFAULT_RSI_MIN_CANDLES} required). "
                f"20-week SMA is available."
            ),
        )

    return TechnicalIndicators(
        symbol=symbol,
        latest_completed_candle_date=latest_date,
        twenty_week_sma=sma,
        weekly_rsi=rsi,
        completed_candles_count=count,
        is_valid=True,
        status_reason=None,
    )
