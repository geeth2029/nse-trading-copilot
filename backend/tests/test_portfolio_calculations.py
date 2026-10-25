from datetime import date
from decimal import Decimal

from app.models import PortfolioPosition, TradeEntry
from app.services.portfolio_calculations import summarize_position


def make_entry(position_id: str, sequence: int, price: str, quantity: int | None) -> TradeEntry:
    return TradeEntry(
        position_id=position_id,
        sequence=sequence,
        entry_type="INITIAL_ENTRY" if sequence == 1 else "PYRAMID_ENTRY",
        entry_date=date(2026, 10, sequence),
        entry_price=Decimal(price),
        stop_loss=Decimal("90.00"),
        rps=Decimal(price) - Decimal("90.00"),
        rpt=Decimal("5000.00"),
        quantity=quantity,
        capital_snapshot=Decimal("500000.00"),
        sizing_status="VALID" if quantity is not None else "INVALID_RPS_WARNING",
    )


def make_position(*entries: TradeEntry) -> PortfolioPosition:
    position = PortfolioPosition(
        id="position-test",
        user_id="user-test",
        instrument_id="instrument-test",
        status="COMPLETED",
        initial_entry_date=date(2026, 10, 1),
    )
    position.entries = list(entries)
    return position


def test_position_summary_calculates_complete_consolidated_pnl():
    position = make_position(
        make_entry("position-test", 1, "100.00", 10),
        make_entry("position-test", 2, "110.00", 5),
    )

    summary = summarize_position(position.entries, exit_price=Decimal("130.00"))

    assert summary.accumulated_quantity == 15
    assert summary.total_capital_deployed == Decimal("1550.00")
    assert summary.average_entry_price == Decimal("103.33")
    assert summary.entry_pnls == (Decimal("300.00"), Decimal("100.00"))
    assert summary.consolidated_pnl == Decimal("400.00")
    assert summary.has_unavailable_quantity is False


def test_unavailable_entry_quantity_makes_consolidated_pnl_unavailable():
    position = make_position(
        make_entry("position-test", 1, "100.00", 10),
        make_entry("position-test", 2, "110.00", 5),
        make_entry("position-test", 3, "120.00", None),
    )

    summary = summarize_position(position.entries, exit_price=Decimal("130.00"))

    assert summary.entry_pnls == (Decimal("300.00"), Decimal("100.00"), None)
    assert summary.consolidated_pnl is None
    assert summary.has_unavailable_quantity is True


def test_zero_quantity_is_a_valid_zero_pnl_not_unavailable():
    position = make_position(
        make_entry("position-test", 1, "100.00", 0),
        make_entry("position-test", 2, "110.00", 5),
    )

    summary = summarize_position(position.entries, exit_price=Decimal("130.00"))

    assert summary.accumulated_quantity == 5
    assert summary.entry_pnls == (Decimal("0.00"), Decimal("100.00"))
    assert summary.consolidated_pnl == Decimal("100.00")
    assert summary.has_unavailable_quantity is False