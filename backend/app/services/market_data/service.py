"""Market data coordination service providing authoritative snapshots and server-derived entry snapshots."""

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_FLOOR
import logging

from app.schemas.portfolio import TradeEntryCreate
from app.services.market_data.base import MarketDataProvider
from app.services.market_data.calendar import IST
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MarketDataError,
    StaleDataError,
)
from app.services.market_data.indicators import calculate_technical_indicators

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MarketSnapshot:
    """Authoritative server-validated market snapshot combining live quote and completed indicators."""

    symbol: str
    instrument_identifier: str
    last_price: Decimal
    quote_timestamp: datetime
    twenty_week_sma: Decimal | None
    weekly_rsi: Decimal | None
    latest_completed_candle_date: date | None
    completed_candles_count: int
    is_stale: bool
    is_eligible_for_initial: bool
    status_reason: str | None = None
    source: str = "UPSTOX"


class MarketDataService:
    """Coordinates market data provider, freshness assessment, and indicator calculation."""

    def __init__(self, provider: MarketDataProvider) -> None:
        self._provider = provider

    @property
    def provider(self) -> MarketDataProvider:
        return self._provider

    async def get_market_snapshot(self, symbol: str) -> MarketSnapshot:
        """Fetch authoritative market snapshot combining verified quote and completed indicators.

        Enforces:
        - Symbol resolution via provider instrument master.
        - Verified quote freshness.
        - Retrieval of at least 100 historical weekly candles.
        - Strict exclusion of incomplete forming candles.
        - Requirement of >= 20 completed candles for 20-week SMA.
        - Requirement of >= 50 completed candles for Wilder's weekly RSI (Phase 4.6B contract).
        - Initial stock qualification: RSI strictly > 60 and non-stale quote.
        """
        norm_symbol = symbol.strip().upper()
        instrument_id = await self._provider.get_instrument_identifier(norm_symbol)
        if not instrument_id:
            raise InstrumentNotFoundError(norm_symbol, "Symbol not recognized by market data provider.")

        # 1. Fetch reference quote
        quote = await self._provider.get_reference_quote(norm_symbol)

        # 2. Fetch historical weekly candles
        candles = await self._provider.get_historical_weekly_candles(norm_symbol, limit_weeks=100)

        # 3. Derive indicators from completed weekly candles
        indicators = calculate_technical_indicators(norm_symbol, candles)

        # 4. Evaluate initial entry qualification
        is_eligible = True
        reasons: list[str] = []

        if quote.is_stale:
            is_eligible = False
            reasons.append("Market quote is stale")

        if indicators.twenty_week_sma is None:
            is_eligible = False
            reasons.append("20-week SMA is unavailable (requires >= 20 completed candles)")

        if indicators.weekly_rsi is None:
            is_eligible = False
            reasons.append(
                f"Weekly RSI unavailable: {indicators.status_reason or 'insufficient completed history (requires >= 50 completed candles)'}"
            )
        elif indicators.weekly_rsi <= Decimal("60"):
            is_eligible = False
            reasons.append(f"Weekly RSI ({indicators.weekly_rsi}) is not strictly greater than 60")

        status_reason = "; ".join(reasons) if reasons else "Eligible for initial entry"

        return MarketSnapshot(
            symbol=norm_symbol,
            instrument_identifier=instrument_id,
            last_price=quote.last_price,
            quote_timestamp=quote.timestamp,
            twenty_week_sma=indicators.twenty_week_sma,
            weekly_rsi=indicators.weekly_rsi,
            latest_completed_candle_date=indicators.latest_completed_candle_date,
            completed_candles_count=indicators.completed_candles_count,
            is_stale=quote.is_stale,
            is_eligible_for_initial=is_eligible,
            status_reason=status_reason,
            source=quote.source,
        )


def derive_initial_entry(
    snapshot: MarketSnapshot,
    capital: Decimal,
    notes: str | None = None,
    execution_price: Decimal | None = None,
    confirm_reference_price_as_execution: bool = False,
    acknowledge_invalid_rps: bool = False,
) -> TradeEntryCreate:
    """Derive an authoritative initial trade entry snapshot using server-verified market data.

    Enforces:
    - Capital must be strictly positive.
    - Market quote must not be stale.
    - 20-week SMA must be available.
    - Weekly RSI must be available and strictly greater than 60.
    - Server-derived entry price, stop-loss, RPS, RPT, quantity, and sizing status.
    - Distinguishes analysis/reference prices from actual executed purchase prices across all providers.
    - Zero calculated quantity is rejected as insufficient capital.
    - Non-positive RPS requires explicit acknowledgement, yielding null quantity and INVALID_RPS_WARNING sizing status.
    """
    if capital <= Decimal("0"):
        raise ValueError("Capital must be greater than zero.")

    if snapshot.is_stale:
        raise ValueError(f"Market quote for '{snapshot.symbol}' is stale; trading requires fresh data.")

    if snapshot.twenty_week_sma is None:
        raise ValueError(
            f"Stock '{snapshot.symbol}' is not eligible: 20-week SMA is unavailable (requires >= 20 completed candles)."
        )

    if snapshot.weekly_rsi is None:
        raise ValueError(
            f"Stock '{snapshot.symbol}' is not eligible: weekly RSI is unavailable (requires >= 50 completed candles)."
        )

    if snapshot.weekly_rsi <= Decimal("60"):
        raise ValueError(
            f"Stock '{snapshot.symbol}' is not eligible: weekly RSI ({snapshot.weekly_rsi}) must be strictly greater than 60."
        )

    entry_date = datetime.now(timezone.utc).astimezone(IST).date()

    if execution_price is not None:
        if execution_price <= Decimal("0"):
            raise ValueError("Execution price must be greater than zero.")
        entry_price = execution_price
    elif confirm_reference_price_as_execution:
        entry_price = snapshot.last_price
    else:
        raise ValueError(
            f"Explicit execution price confirmation is required. "
            f"Please specify an actual execution fill price or explicitly confirm using the reference closing price of ₹{snapshot.last_price}."
        )

    stop_loss = snapshot.twenty_week_sma

    rps = entry_price - stop_loss
    rpt = capital * Decimal("0.01")

    if rps <= Decimal("0"):
        if not acknowledge_invalid_rps:
            raise ValueError(
                f"Stop-Loss (₹{stop_loss}) is greater than or equal to Entry Price (₹{entry_price}), "
                f"resulting in a non-positive Risk Per Share of ₹{rps}. "
                f"Explicit acknowledgement of this invalid risk per share is required to record this entry."
            )
        quantity: int | None = None
        sizing_status = "INVALID_RPS_WARNING"
    else:
        calc_qty = int((rpt / rps).to_integral_value(rounding=ROUND_FLOOR))
        if calc_qty <= 0:
            raise ValueError(
                f"Calculated quantity is 0 shares because Risk Per Trade (₹{rpt}) is less than Risk Per Share (₹{rps}). "
                f"Capital of ₹{capital} is insufficient to allocate at least 1 whole share under the 1% risk rule."
            )
        quantity = calc_qty
        sizing_status = "VALID"

    return TradeEntryCreate(
        sequence=1,
        entry_type="INITIAL_ENTRY",
        entry_date=entry_date,
        entry_price=entry_price,
        stop_loss=stop_loss,
        rps=rps,
        rpt=rpt,
        quantity=quantity,
        capital_snapshot=capital,
        sizing_status=sizing_status,
        notes=notes,
    )


def derive_pyramid_entry(
    snapshot: MarketSnapshot,
    capital: Decimal,
    previous_entry_price: Decimal,
    next_sequence: int,
    notes: str | None = None,
    execution_price: Decimal | None = None,
    confirm_reference_price_as_execution: bool = False,
    acknowledge_invalid_rps: bool = False,
) -> TradeEntryCreate:
    """Derive an authoritative pyramid trade entry snapshot using server-verified market data.

    Enforces:
    - Capital must be strictly positive.
    - Market quote must not be stale.
    - Weekly RSI must be available and strictly greater than 60.
    - Established inclusive tolerance rule: previous_entry_price <= SMA20 <= previous_entry_price + 3.00.
    - Server-derived entry price, stop-loss, RPS, RPT, quantity, sequence, and sizing status.
    - Distinguishes analysis/reference prices from actual executed purchase prices across all providers.
    - Zero calculated quantity is rejected as insufficient capital.
    - Non-positive RPS requires explicit acknowledgement, yielding null quantity and INVALID_RPS_WARNING sizing status.
    """
    if capital <= Decimal("0"):
        raise ValueError("Capital must be greater than zero.")

    if snapshot.is_stale:
        raise ValueError(f"Market quote for '{snapshot.symbol}' is stale; trading requires fresh data.")

    if snapshot.twenty_week_sma is None:
        raise ValueError(f"Position '{snapshot.symbol}' cannot be pyramided: 20-week SMA is unavailable.")

    if snapshot.weekly_rsi is None:
        raise ValueError(
            f"Position '{snapshot.symbol}' cannot be pyramided: weekly RSI is unavailable (requires >= 50 completed candles)."
        )

    if snapshot.weekly_rsi <= Decimal("60"):
        raise ValueError(
            f"Position '{snapshot.symbol}' is not eligible for pyramiding: weekly RSI ({snapshot.weekly_rsi}) must be strictly greater than 60."
        )

    sma20 = snapshot.twenty_week_sma
    max_tolerance_sma = previous_entry_price + Decimal("3.00")

    if not (previous_entry_price <= sma20 <= max_tolerance_sma):
        raise ValueError(
            f"Position '{snapshot.symbol}' is not eligible for pyramiding: 20-week SMA ({sma20}) is outside the required tolerance [{previous_entry_price}, {max_tolerance_sma}]."
        )

    entry_date = datetime.now(timezone.utc).astimezone(IST).date()

    if execution_price is not None:
        if execution_price <= Decimal("0"):
            raise ValueError("Execution price must be greater than zero.")
        entry_price = execution_price
    elif confirm_reference_price_as_execution:
        entry_price = snapshot.last_price
    else:
        raise ValueError(
            f"Explicit execution price confirmation is required. "
            f"Please specify an actual execution fill price or explicitly confirm using the reference closing price of ₹{snapshot.last_price}."
        )

    stop_loss = sma20

    rps = entry_price - stop_loss
    rpt = capital * Decimal("0.01")

    if rps <= Decimal("0"):
        if not acknowledge_invalid_rps:
            raise ValueError(
                f"Stop-Loss (₹{stop_loss}) is greater than or equal to Entry Price (₹{entry_price}), "
                f"resulting in a non-positive Risk Per Share of ₹{rps}. "
                f"Explicit acknowledgement of this invalid risk per share is required to record this entry."
            )
        quantity: int | None = None
        sizing_status = "INVALID_RPS_WARNING"
    else:
        calc_qty = int((rpt / rps).to_integral_value(rounding=ROUND_FLOOR))
        if calc_qty <= 0:
            raise ValueError(
                f"Calculated quantity is 0 shares because Risk Per Trade (₹{rpt}) is less than Risk Per Share (₹{rps}). "
                f"Capital of ₹{capital} is insufficient to allocate at least 1 whole share under the 1% risk rule."
            )
        quantity = calc_qty
        sizing_status = "VALID"

    return TradeEntryCreate(
        sequence=next_sequence,
        entry_type="PYRAMID_ENTRY",
        entry_date=entry_date,
        entry_price=entry_price,
        stop_loss=stop_loss,
        rps=rps,
        rpt=rpt,
        quantity=quantity,
        capital_snapshot=capital,
        sizing_status=sizing_status,
        notes=notes,
    )
