from datetime import date, timedelta
from decimal import Decimal
import pytest

from app.services.market_data.base import TechnicalIndicators, WeeklyCandle
from app.services.market_data.indicators import (
    DEFAULT_RSI_MIN_CANDLES,
    DEFAULT_SMA_PERIOD,
    InvalidCandleDataError,
    calculate_technical_indicators,
    calculate_twenty_week_sma,
    calculate_wilders_rsi,
    validate_and_prepare_candles,
)


def make_candle(
    symbol: str = "INFY",
    candle_date: date | None = None,
    open_price: str = "100.00",
    high_price: str = "105.00",
    low_price: str = "95.00",
    close_price: str = "100.00",
    volume: int = 100000,
    is_completed: bool = True,
) -> WeeklyCandle:
    return WeeklyCandle(
        symbol=symbol,
        candle_date=candle_date or date(2026, 1, 2),
        open_price=Decimal(open_price),
        high_price=Decimal(high_price),
        low_price=Decimal(low_price),
        close_price=Decimal(close_price),
        volume=volume,
        is_completed=is_completed,
    )


def generate_candle_series(
    closes: list[Decimal],
    start_date: date = date(2025, 1, 3),
    symbol: str = "INFY",
    is_completed: bool = True,
) -> list[WeeklyCandle]:
    """Generates a sequence of weekly Friday candles with valid OHLC prices."""
    candles: list[WeeklyCandle] = []
    for i, close in enumerate(closes):
        c_date = start_date + timedelta(weeks=i)
        # Ensure High >= max(Open, Close) and Low <= min(Open, Close)
        open_price = close
        high_price = close + Decimal("5.00")
        low_price = close - Decimal("5.00")
        candles.append(
            WeeklyCandle(
                symbol=symbol,
                candle_date=c_date,
                open_price=open_price,
                high_price=high_price,
                low_price=low_price,
                close_price=close,
                volume=100000,
                is_completed=is_completed,
            )
        )
    return candles


# 1. Exact 20-week SMA calculation using known decimal prices
def test_exact_twenty_week_sma_calculation():
    # 20 weekly closes from 100.00 to 119.00
    # Sum = 2000 + (19 * 20) / 2 = 2190.00
    # Average = 2190.00 / 20 = 109.50
    closes_20 = [Decimal(str(100 + i)) for i in range(20)]
    candles_20 = generate_candle_series(closes_20)

    sma_20 = calculate_twenty_week_sma(candles_20)
    assert sma_20 is not None
    assert sma_20 == Decimal("109.50")

    # Sequential 21st candle at 120.00:
    # 21 closes: 100.00, 101.00, ..., 120.00
    # Latest 20 completed candles: 101.00 to 120.00 (100.00 is dropped)
    # Sum = 2190.00 - 100.00 + 120.00 = 2210.00
    # Average = 2210.00 / 20 = 110.50 (exact)
    candles_21_consecutive = generate_candle_series(closes_20 + [Decimal("120.00")])
    sma_21_consecutive = calculate_twenty_week_sma(candles_21_consecutive)
    assert sma_21_consecutive == Decimal("110.50")

    # In addition, testing an explicit non-integer price jump at index 20 (close = 139.50):
    # Latest 20 completed window: [101.00 .. 119.00] + [139.50]
    # Sum = 2090.00 + 139.50 = 2229.50
    # Average = 2229.50 / 20 = 111.475 -> rounded to CENT = 111.48
    candles_21_jump = generate_candle_series(closes_20 + [Decimal("139.50")])
    sma_21_jump = calculate_twenty_week_sma(candles_21_jump)
    assert sma_21_jump == Decimal("111.48")


# Focused Numerical Audit: Verify latest 20 completed candle selection & average
def test_twenty_week_sma_latest_selection_and_average_audit():
    """Audits exact latest-20 candle selection from a multi-candle series.
    
    Given 21 completed candles with prices [100.00, 101.00, ..., 120.00]:
    - Candle 0 (100.00) must be excluded from the 20-week window.
    - Candles 1..20 (101.00..120.00) must be included.
    - Sum = 2210.00, Mean = 110.50.
    """
    all_closes = [Decimal(str(100 + i)) for i in range(21)]
    assert len(all_closes) == 21
    assert all_closes[0] == Decimal("100")
    assert all_closes[-1] == Decimal("120")

    candles = generate_candle_series(all_closes)
    sma = calculate_twenty_week_sma(candles)
    assert sma == Decimal("110.50")

    # Add an incomplete 22nd candle (e.g. current week at 999.00)
    incomplete_candle = make_candle(
        candle_date=date(2025, 6, 6),
        close_price="999.00",
        high_price="1000.00",
        low_price="990.00",
        open_price="995.00",
        is_completed=False,
    )
    candles_with_incomplete = candles + [incomplete_candle]

    # Incomplete candle must be ignored; latest 20 completed must still average to 110.50
    sma_with_incomplete = calculate_twenty_week_sma(candles_with_incomplete)
    assert sma_with_incomplete == Decimal("110.50")

    # Reorder candles randomly/in reverse; result must be identical
    reversed_candles = list(reversed(candles_with_incomplete))
    sma_reversed = calculate_twenty_week_sma(reversed_candles)
    assert sma_reversed == Decimal("110.50")


# 2. Insufficient history with 19 completed candles
def test_insufficient_history_for_twenty_week_sma():
    closes = [Decimal(str(100 + i)) for i in range(19)]
    candles = generate_candle_series(closes)

    # Standalone function returns None
    sma = calculate_twenty_week_sma(candles)
    assert sma is None

    # Consolidated indicators reports unavailable with clear status reason
    indicators = calculate_technical_indicators("INFY", candles)
    assert indicators.twenty_week_sma is None
    assert indicators.weekly_rsi is None
    assert indicators.is_valid is False
    assert indicators.completed_candles_count == 19
    assert indicators.status_reason is not None
    assert "19/20 required for SMA" in indicators.status_reason


# 3. RSI calculation against independently calculated reference values
def test_wilders_rsi_accuracy_against_reference_values():
    # 55 deterministic closing prices with known variations
    closes = [Decimal(str(100 + (i % 5) * 2 - (i % 3))) for i in range(55)]
    candles = generate_candle_series(closes)

    rsi = calculate_wilders_rsi(candles)
    assert rsi is not None
    # Verified independently: 55.9556
    assert rsi == Decimal("55.9556")

    # Verify indicators integration
    indicators = calculate_technical_indicators("INFY", candles)
    assert indicators.weekly_rsi == Decimal("55.9556")
    assert indicators.twenty_week_sma is not None
    assert indicators.is_valid is True
    assert indicators.status_reason is None


# 4. RSI edge cases: flat prices, continuous gains, and continuous losses
def test_rsi_edge_cases_flat_monotonic_gains_and_losses():
    # Edge Case A: Flat prices (all 50 candles identical) -> RSI = 50.0000
    flat_closes = [Decimal("150.00")] * 50
    flat_candles = generate_candle_series(flat_closes)
    flat_rsi = calculate_wilders_rsi(flat_candles)
    assert flat_rsi == Decimal("50.0000")

    # Edge Case B: Continuous gains (every candle increases) -> RSI = 100.0000
    up_closes = [Decimal(str(100 + i * 2)) for i in range(50)]
    up_candles = generate_candle_series(up_closes)
    up_rsi = calculate_wilders_rsi(up_candles)
    assert up_rsi == Decimal("100.0000")

    # Edge Case C: Continuous losses (every candle decreases) -> RSI = 0.0000
    down_closes = [Decimal(str(300 - i * 2)) for i in range(50)]
    down_candles = generate_candle_series(down_closes)
    down_rsi = calculate_wilders_rsi(down_candles)
    assert down_rsi == Decimal("0.0000")


# 5. Insufficient RSI history with 49 completed candles
def test_insufficient_rsi_history_with_49_completed_candles():
    closes = [Decimal(str(100 + i)) for i in range(49)]
    candles = generate_candle_series(closes)

    # Standalone RSI returns None
    rsi = calculate_wilders_rsi(candles)
    assert rsi is None

    # SMA is available because 49 >= 20
    sma = calculate_twenty_week_sma(candles)
    assert sma is not None

    # Overall indicators is_valid must be False because full strategy requires both
    indicators = calculate_technical_indicators("INFY", candles)
    assert indicators.twenty_week_sma is not None
    assert indicators.weekly_rsi is None
    assert indicators.is_valid is False
    assert indicators.completed_candles_count == 49
    assert indicators.status_reason is not None
    assert "49/50 required" in indicators.status_reason
    assert "20-week SMA is available" in indicators.status_reason


# 6. RSI availability with exactly 50 completed candles
def test_rsi_availability_with_exactly_50_completed_candles():
    closes = [Decimal(str(100 + (i % 3) * 5)) for i in range(50)]
    candles = generate_candle_series(closes)

    rsi = calculate_wilders_rsi(candles)
    assert rsi is not None
    assert isinstance(rsi, Decimal)
    assert Decimal("0.0") <= rsi <= Decimal("100.0")

    indicators = calculate_technical_indicators("INFY", candles)
    assert indicators.weekly_rsi is not None
    assert indicators.twenty_week_sma is not None
    assert indicators.completed_candles_count == 50
    assert indicators.is_valid is True
    assert indicators.status_reason is None


# 7. Exclusion of an incomplete weekly candle
def test_exclusion_of_incomplete_weekly_candle():
    closes = [Decimal(str(100 + i)) for i in range(20)]
    candles = generate_candle_series(closes)

    # Add 21st candle representing the currently forming week (is_completed=False)
    incomplete_candle = make_candle(
        candle_date=date(2026, 6, 5),
        close_price="999.00",
        high_price="1000.00",
        low_price="990.00",
        open_price="995.00",
        is_completed=False,
    )
    all_candles = candles + [incomplete_candle]

    # SMA must ignore the 999.00 incomplete candle and calculate from the 20 completed
    sma = calculate_twenty_week_sma(all_candles)
    expected_sma = calculate_twenty_week_sma(candles)
    assert sma == expected_sma

    # Test that 50 candles where 1 is incomplete results in 49 completed candles -> RSI unavailable
    closes_50 = [Decimal(str(100 + i)) for i in range(50)]
    candles_50 = generate_candle_series(closes_50)
    # Mark the last candle as incomplete
    candles_50[-1] = WeeklyCandle(
        symbol="INFY",
        candle_date=candles_50[-1].candle_date,
        open_price=candles_50[-1].open_price,
        high_price=candles_50[-1].high_price,
        low_price=candles_50[-1].low_price,
        close_price=candles_50[-1].close_price,
        volume=100000,
        is_completed=False,
    )

    indicators = calculate_technical_indicators("INFY", candles_50)
    assert indicators.completed_candles_count == 49
    assert indicators.weekly_rsi is None
    assert indicators.is_valid is False


# 8. Correct results when valid candles arrive in reverse chronological order
def test_chronological_ordering_handling():
    closes = [Decimal(str(100 + i)) for i in range(50)]
    ascending = generate_candle_series(closes)
    descending = list(reversed(ascending))

    # Both SMA and RSI must be identical regardless of input ordering
    sma_asc = calculate_twenty_week_sma(ascending)
    sma_desc = calculate_twenty_week_sma(descending)
    assert sma_asc == sma_desc

    rsi_asc = calculate_wilders_rsi(ascending)
    rsi_desc = calculate_wilders_rsi(descending)
    assert rsi_asc == rsi_desc

    indicators_asc = calculate_technical_indicators("INFY", ascending)
    indicators_desc = calculate_technical_indicators("INFY", descending)
    assert indicators_asc.twenty_week_sma == indicators_desc.twenty_week_sma
    assert indicators_asc.weekly_rsi == indicators_desc.weekly_rsi
    assert indicators_asc.latest_completed_candle_date == indicators_desc.latest_completed_candle_date


# 9. Rejection of duplicate dates, invalid OHLC relationships, and malformed prices
def test_rejection_of_invalid_and_malformed_candles():
    valid_date = date(2026, 1, 9)

    # 1. Non-positive price
    with pytest.raises(InvalidCandleDataError, match="non-positive"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, close_price="-10.00")
        ])

    with pytest.raises(InvalidCandleDataError, match="non-positive"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, open_price="0.00")
        ])

    # 2. Negative volume
    with pytest.raises(InvalidCandleDataError, match="negative volume"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, volume=-50)
        ])

    # 3. High < Low
    with pytest.raises(InvalidCandleDataError, match="High .* < Low"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, high_price="90.00", low_price="95.00")
        ])

    # 4. High < Close or High < Open
    with pytest.raises(InvalidCandleDataError, match="High .* less than Open .* or Close"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, high_price="100.00", close_price="105.00")
        ])

    # 5. Low > Close or Low > Open
    with pytest.raises(InvalidCandleDataError, match="Low .* greater than Open .* or Close"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, low_price="105.00", open_price="100.00")
        ])

    # 6. Duplicate candle dates
    with pytest.raises(InvalidCandleDataError, match="Duplicate candle date detected"):
        validate_and_prepare_candles([
            make_candle(candle_date=valid_date, close_price="100.00"),
            make_candle(candle_date=valid_date, close_price="102.00"),
        ])


# 10. Decimal precision and deterministic repeated calculations
def test_decimal_precision_and_deterministic_repeatability():
    closes = [Decimal(str(100 + (i % 7) * 3 - (i % 4))) for i in range(52)]
    candles = generate_candle_series(closes)

    # Execute multiple times
    results_sma = [calculate_twenty_week_sma(candles) for _ in range(5)]
    results_rsi = [calculate_wilders_rsi(candles) for _ in range(5)]

    # All executions must match exactly with zero deviation
    for s in results_sma:
        assert s == results_sma[0]
        assert isinstance(s, Decimal)

    for r in results_rsi:
        assert r == results_rsi[0]
        assert isinstance(r, Decimal)


# 11. Explicit unavailable results and reasons for invalid or insufficient data
def test_explicit_unavailable_results_and_reasons():
    # Empty list
    empty_res = calculate_technical_indicators("INFY", [])
    assert empty_res.is_valid is False
    assert empty_res.twenty_week_sma is None
    assert empty_res.weekly_rsi is None
    assert empty_res.completed_candles_count == 0
    assert empty_res.latest_completed_candle_date is None
    assert "No completed weekly candles available" in (empty_res.status_reason or "")

    # Only uncompleted candles
    incomplete_only = [
        make_candle(candle_date=date(2026, 1, 2), is_completed=False),
        make_candle(candle_date=date(2026, 1, 9), is_completed=False),
    ]
    inc_res = calculate_technical_indicators("INFY", incomplete_only)
    assert inc_res.is_valid is False
    assert inc_res.completed_candles_count == 0
    assert inc_res.status_reason == "No completed weekly candles available."
