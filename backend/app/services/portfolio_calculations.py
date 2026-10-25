from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from app.models.portfolio import TradeEntry

CENT = Decimal("0.01")


@dataclass(frozen=True, slots=True)
class PositionSummary:
    accumulated_quantity: int
    average_entry_price: Decimal
    total_capital_deployed: Decimal
    entry_pnls: tuple[Decimal | None, ...]
    consolidated_pnl: Decimal | None
    has_unavailable_quantity: bool


def calculate_entry_pnl(
    entry_price: Decimal,
    exit_price: Decimal,
    quantity: int | None,
) -> Decimal | None:
    if quantity is None or quantity < 0 or exit_price <= 0:
        return None
    return ((exit_price - entry_price) * quantity).quantize(CENT)


def summarize_position(
    entries: Iterable[TradeEntry],
    *,
    exit_price: Decimal | None = None,
) -> PositionSummary:
    entry_rows = tuple(entries)
    valid_rows = tuple(entry for entry in entry_rows if entry.quantity is not None and entry.quantity >= 0)
    accumulated_quantity = sum(entry.quantity for entry in valid_rows if entry.quantity is not None)
    total_capital_deployed = sum(
        (entry.entry_price * entry.quantity for entry in valid_rows if entry.quantity is not None),
        start=Decimal("0"),
    ).quantize(CENT)
    average_entry_price = (
        (total_capital_deployed / accumulated_quantity).quantize(CENT)
        if accumulated_quantity > 0
        else Decimal("0")
    )

    entry_pnls = tuple(
        calculate_entry_pnl(entry.entry_price, exit_price, entry.quantity)
        if exit_price is not None
        else None
        for entry in entry_rows
    )
    has_unavailable_quantity = any(pnl is None for pnl in entry_pnls) if exit_price is not None else False
    consolidated_pnl = (
        sum(entry_pnls, start=Decimal("0")).quantize(CENT)
        if exit_price is not None and not has_unavailable_quantity
        else None
    )

    return PositionSummary(
        accumulated_quantity=accumulated_quantity,
        average_entry_price=average_entry_price,
        total_capital_deployed=total_capital_deployed,
        entry_pnls=entry_pnls,
        consolidated_pnl=consolidated_pnl,
        has_unavailable_quantity=has_unavailable_quantity,
    )