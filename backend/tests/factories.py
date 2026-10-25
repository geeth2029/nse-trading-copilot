from datetime import date
from decimal import Decimal

from app.models import Instrument, PortfolioPosition, TradeEntry, User


def add_user(session, *, email: str = "owner@example.test") -> User:
    user = User(email=email, password_hash="test-hash-only")
    session.add(user)
    session.flush()
    return user


def add_instrument(session, *, symbol: str = "RELIANCE") -> Instrument:
    instrument = Instrument(
        canonical_symbol=f"{symbol}.NS",
        symbol=symbol,
        display_name=f"{symbol} Ltd",
        exchange="NSE",
    )
    session.add(instrument)
    session.flush()
    return instrument


def add_position(session, *, user_id: str, instrument_id: str, status: str = "ACTIVE") -> PortfolioPosition:
    position = PortfolioPosition(
        user_id=user_id,
        instrument_id=instrument_id,
        status=status,
        initial_entry_date=date(2026, 10, 1),
    )
    session.add(position)
    session.flush()
    return position


def make_entry(
    position_id: str,
    sequence: int,
    *,
    entry_type: str | None = None,
    price: str = "100.00",
    stop_loss: str = "90.00",
    rps: str = "10.00",
    rpt: str = "50.00",
    quantity: int | None = 5,
    capital: str = "5000.00",
    sizing_status: str = "VALID",
) -> TradeEntry:
    return TradeEntry(
        position_id=position_id,
        sequence=sequence,
        entry_type=entry_type or ("INITIAL_ENTRY" if sequence == 1 else "PYRAMID_ENTRY"),
        entry_date=date(2026, 10, sequence),
        entry_price=Decimal(price),
        stop_loss=Decimal(stop_loss),
        rps=Decimal(rps),
        rpt=Decimal(rpt),
        quantity=quantity,
        capital_snapshot=Decimal(capital),
        sizing_status=sizing_status,
    )