from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.portfolio import PortfolioPosition, PositionExit, TradeEntry
from app.repositories.portfolio import get_position_for_user
from app.schemas.portfolio import TradeEntryCreate


class EntryNotFoundError(LookupError):
    """Raised when the requested entry does not exist."""


class PositionNotFoundError(LookupError):
    """Raised when a position is absent or outside the supplied owner scope."""


def create_position(
    session: Session,
    *,
    user_id: str,
    instrument_id: str,
    initial_entry: TradeEntryCreate,
) -> PortfolioPosition:
    """Create a new portfolio position with its initial entry snapshot."""
    if initial_entry.sequence != 1 or initial_entry.entry_type != "INITIAL_ENTRY":
        raise ValueError("Initial entry must have sequence 1 and entry_type 'INITIAL_ENTRY'.")

    position = PortfolioPosition(
        user_id=user_id,
        instrument_id=instrument_id,
        status="ACTIVE",
        initial_entry_date=initial_entry.entry_date,
    )
    session.add(position)
    session.flush()

    create_trade_entry(
        session,
        user_id=user_id,
        position_id=position.id,
        entry_data=initial_entry,
    )
    return position


def record_position_exit(
    session: Session,
    *,
    user_id: str,
    position_id: str,
    exit_price: Decimal,
    exit_date: date,
    notes: str | None = None,
) -> PositionExit:
    """Record an exit for the entire accumulated position."""
    position = get_position_for_user(session, user_id=user_id, position_id=position_id)
    if position is None:
        raise PositionNotFoundError(position_id)
    if position.exit is not None:
        raise ValueError("An exit has already been recorded for this position.")
    if exit_price <= 0:
        raise ValueError("Exit price must be greater than zero.")
    if exit_date < position.initial_entry_date:
        raise ValueError("Exit date cannot precede initial entry date.")

    exit_record = PositionExit(
        position_id=position.id,
        exit_price=exit_price,
        exit_date=exit_date,
        notes=notes,
    )
    position.exit = exit_record
    position.status = "COMPLETED"
    session.add(exit_record)
    session.flush()
    return exit_record


def create_trade_entry(
    session: Session,
    *,
    user_id: str,
    position_id: str,
    entry_data: TradeEntryCreate,
) -> TradeEntry:
    """Create an entry only through validated, immutable snapshot input."""
    position = get_position_for_user(session, user_id=user_id, position_id=position_id)
    if position is None:
        raise PositionNotFoundError(position_id)
    entry = TradeEntry(position_id=position.id, **entry_data.model_dump())
    position.entries.append(entry)
    session.add(entry)
    session.flush()
    return entry


def update_trade_entry_notes(
    session: Session,
    *,
    user_id: str,
    position_id: str,
    entry_id: str,
    notes: str | None,
) -> TradeEntry:
    """Update non-calculation notes; recorded sizing snapshots are not editable."""
    position = get_position_for_user(session, user_id=user_id, position_id=position_id)
    if position is None:
        raise PositionNotFoundError(position_id)
    entry = session.scalar(
        select(TradeEntry).where(
            TradeEntry.id == entry_id,
            TradeEntry.position_id == position.id,
        )
    )
    if entry is None:
        raise EntryNotFoundError(entry_id)
    entry.notes = notes
    session.flush()
    return entry


def update_trade_entry(*, user_id: str, position_id: str, entry_id: str, **changes) -> None:
    """Reject general entry edits; immutable snapshots have no approved edit workflow."""
    forbidden = {"entry_date", "entry_price", "stop_loss", "rps", "rpt", "quantity", "capital_snapshot"}
    attempted = forbidden.intersection(changes)
    if attempted:
        raise ValueError(f"Trade entry snapshot fields are immutable: {', '.join(sorted(attempted))}")
    if changes:
        raise ValueError("Only entry notes may be changed through the entry service.")
    raise ValueError(f"No entry edit operation is available for {entry_id} in position {position_id}.")


def archive_position(
    session: Session,
    *,
    user_id: str,
    position_id: str,
    reason: str | None = None,
) -> PortfolioPosition:
    """Soft-archive a position while retaining its entries and shared exit."""
    position = get_position_for_user(session, user_id=user_id, position_id=position_id)
    if position is None:
        raise PositionNotFoundError(position_id)
    position.status = "ARCHIVED"
    position.archived_at = datetime.now(UTC)
    position.archive_reason = reason
    session.flush()
    return position


def restore_position(
    session: Session,
    *,
    user_id: str,
    position_id: str,
) -> PortfolioPosition:
    """Restore an archived position back to ACTIVE or COMPLETED status."""
    position = get_position_for_user(session, user_id=user_id, position_id=position_id)
    if position is None:
        raise PositionNotFoundError(position_id)
    if position.status != "ARCHIVED":
        raise ValueError("Cannot restore a position that is not archived.")

    if position.exit is not None:
        position.status = "COMPLETED"
    else:
        existing_active = session.scalar(
            select(PortfolioPosition).where(
                PortfolioPosition.user_id == user_id,
                PortfolioPosition.instrument_id == position.instrument_id,
                PortfolioPosition.status == "ACTIVE",
                PortfolioPosition.id != position.id,
            )
        )
        if existing_active is not None:
            raise ValueError(f"An active position already exists for {position.instrument.symbol}.")
        position.status = "ACTIVE"

    position.archived_at = None
    position.archive_reason = None
    session.flush()
    return position

