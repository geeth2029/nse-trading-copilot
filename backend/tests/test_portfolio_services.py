from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.models import PositionExit
from app.repositories.portfolio import get_position_for_user
from app.schemas.portfolio import TradeEntryCreate
from app.services.portfolio import (
    PositionNotFoundError,
    archive_position,
    create_trade_entry,
    record_position_exit,
    restore_position,
    update_trade_entry,
    update_trade_entry_notes,
)
from tests.factories import add_instrument, add_position, add_user


def valid_entry_payload(**overrides) -> TradeEntryCreate:
    values = {
        "sequence": 1,
        "entry_type": "INITIAL_ENTRY",
        "entry_date": date(2026, 10, 1),
        "entry_price": Decimal("100.00"),
        "stop_loss": Decimal("90.00"),
        "rps": Decimal("10.00"),
        "rpt": Decimal("50.00"),
        "quantity": 5,
        "capital_snapshot": Decimal("5000.00"),
        "sizing_status": "VALID",
    }
    values.update(overrides)
    return TradeEntryCreate(**values)


def test_entry_schema_rejects_inconsistent_valid_sizing():
    with pytest.raises(ValidationError):
        valid_entry_payload(quantity=4)

    with pytest.raises(ValidationError):
        valid_entry_payload(rps=Decimal("9.00"))

    with pytest.raises(ValidationError):
        valid_entry_payload(rpt=Decimal("49.00"))

    with pytest.raises(ValidationError):
        valid_entry_payload(rps=Decimal("-5.00"), stop_loss=Decimal("105.00"))


def test_zero_quantity_is_rejected_and_cannot_be_valid():
    # Priority 3: Zero quantity must not be labeled VALID and cannot be recorded
    with pytest.raises(ValidationError, match="Valid sizing requires positive capital, positive RPS, and a positive quantity"):
        valid_entry_payload(
            rpt=Decimal("5.00"),
            capital_snapshot=Decimal("500.00"),
            quantity=0,
            sizing_status="VALID",
        )


def test_invalid_rps_warning_remains_representable_without_quantity():
    payload = valid_entry_payload(
        entry_price=Decimal("100.00"),
        stop_loss=Decimal("105.00"),
        rps=Decimal("-5.00"),
        quantity=None,
        sizing_status="INVALID_RPS_WARNING",
    )

    assert payload.rps == Decimal("-5.00")
    assert payload.quantity is None


def test_entry_service_preserves_snapshot_and_only_updates_notes(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id)
    payload = valid_entry_payload()

    entry = create_trade_entry(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_data=payload,
    )
    original_snapshot = (
        entry.entry_date,
        entry.entry_price,
        entry.stop_loss,
        entry.rps,
        entry.rpt,
        entry.quantity,
    )
    update_trade_entry_notes(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_id=entry.id,
        notes="annotation",
    )

    assert entry.notes == "annotation"
    assert (
        entry.entry_date,
        entry.entry_price,
        entry.stop_loss,
        entry.rps,
        entry.rpt,
        entry.quantity,
    ) == original_snapshot
    with pytest.raises(ValueError, match="immutable"):
        update_trade_entry(
            user_id=user.id,
            position_id=position.id,
            entry_id=entry.id,
            entry_price=Decimal("101.00"),
        )


def test_archiving_preserves_position_entries_and_exit(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id, status="COMPLETED")
    first = create_trade_entry(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_data=valid_entry_payload(),
    )
    second = create_trade_entry(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_data=valid_entry_payload(
            sequence=2,
            entry_type="PYRAMID_ENTRY",
            entry_price=Decimal("110.00"),
            stop_loss=Decimal("100.00"),
            rps=Decimal("10.00"),
            quantity=5,
        ),
    )
    exit_record = PositionExit(
        position_id=position.id,
        exit_price=Decimal("125.00"),
        exit_date=date(2026, 10, 20),
    )
    position.exit = exit_record
    session.flush()

    archive_position(
        session,
        user_id=user.id,
        position_id=position.id,
        reason="Archived in test",
    )
    session.expire_all()
    archived = get_position_for_user(session, user_id=user.id, position_id=position.id)

    assert archived is not None
    assert archived.status == "ARCHIVED"
    assert archived.archived_at is not None
    assert archived.archive_reason == "Archived in test"
    assert [entry.id for entry in archived.entries] == [first.id, second.id]
    assert archived.entries[0].entry_price == Decimal("100.0000")
    assert archived.entries[1].entry_price == Decimal("110.0000")
    assert archived.exit is not None
    assert archived.exit.exit_price == Decimal("125.0000")
    assert archived.exit.exit_date == date(2026, 10, 20)


def test_portfolio_service_mutations_reject_cross_user_access(session):
    user_a = add_user(session, email="usera@example.test")
    user_b = add_user(session, email="userb@example.test")
    instrument = add_instrument(session)
    position_a = add_position(session, user_id=user_a.id, instrument_id=instrument.id)
    entry_a = create_trade_entry(
        session,
        user_id=user_a.id,
        position_id=position_a.id,
        entry_data=valid_entry_payload(),
    )

    # user_b attempts to create an entry on user_a's position -> PositionNotFoundError
    with pytest.raises(PositionNotFoundError):
        create_trade_entry(
            session,
            user_id=user_b.id,
            position_id=position_a.id,
            entry_data=valid_entry_payload(sequence=2, entry_type="PYRAMID_ENTRY"),
        )

    # user_b attempts to update notes on user_a's entry -> PositionNotFoundError
    with pytest.raises(PositionNotFoundError):
        update_trade_entry_notes(
            session,
            user_id=user_b.id,
            position_id=position_a.id,
            entry_id=entry_a.id,
            notes="unauthorized note",
        )

    # user_b attempts to archive user_a's position -> PositionNotFoundError
    with pytest.raises(PositionNotFoundError):
        archive_position(
            session,
            user_id=user_b.id,
            position_id=position_a.id,
            reason="unauthorized archive",
        )

    # user_b attempts to restore user_a's position -> PositionNotFoundError
    with pytest.raises(PositionNotFoundError):
        restore_position(
            session,
            user_id=user_b.id,
            position_id=position_a.id,
        )


def test_restore_position_transitions_unexited_to_active(session):
    user = add_user(session, email="restore_active@example.test")
    instrument = add_instrument(session, symbol="RESTORE_ACT")
    position = add_position(session, user_id=user.id, instrument_id=instrument.id, status="ACTIVE")
    create_trade_entry(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_data=valid_entry_payload(),
    )
    archive_position(session, user_id=user.id, position_id=position.id, reason="Temporary archive")
    assert position.status == "ARCHIVED"
    assert position.archived_at is not None
    assert position.archive_reason == "Temporary archive"

    restored = restore_position(session, user_id=user.id, position_id=position.id)
    assert restored.status == "ACTIVE"
    assert restored.archived_at is None
    assert restored.archive_reason is None
    assert len(restored.entries) == 1
    assert restored.entries[0].quantity == 5


def test_restore_position_transitions_exited_to_completed(session):
    user = add_user(session, email="restore_comp@example.test")
    instrument = add_instrument(session, symbol="RESTORE_COMP")
    position = add_position(session, user_id=user.id, instrument_id=instrument.id, status="ACTIVE")
    create_trade_entry(
        session,
        user_id=user.id,
        position_id=position.id,
        entry_data=valid_entry_payload(),
    )
    record_position_exit(
        session,
        user_id=user.id,
        position_id=position.id,
        exit_price=Decimal("120.00"),
        exit_date=date(2026, 10, 15),
        notes="Profitable exit",
    )
    assert position.status == "COMPLETED"

    archive_position(session, user_id=user.id, position_id=position.id, reason="Archived completed")
    assert position.status == "ARCHIVED"

    restored = restore_position(session, user_id=user.id, position_id=position.id)
    assert restored.status == "COMPLETED"
    assert restored.archived_at is None
    assert restored.archive_reason is None
    assert restored.exit is not None
    assert restored.exit.exit_price == Decimal("120.00")
    assert restored.exit.notes == "Profitable exit"
    assert len(restored.entries) == 1


def test_restore_position_rejects_non_archived_position(session):
    user = add_user(session, email="restore_fail@example.test")
    instrument = add_instrument(session, symbol="RESTORE_FAIL")
    position = add_position(session, user_id=user.id, instrument_id=instrument.id, status="ACTIVE")

    with pytest.raises(ValueError, match="Cannot restore a position that is not archived."):
        restore_position(session, user_id=user.id, position_id=position.id)


def test_restore_position_rejects_when_active_position_already_exists(session):
    user = add_user(session, email="restore_dup@example.test")
    instrument = add_instrument(session, symbol="DUP_ACT")

    # Pos 1 is archived unexited
    pos1 = add_position(session, user_id=user.id, instrument_id=instrument.id, status="ACTIVE")
    archive_position(session, user_id=user.id, position_id=pos1.id, reason="Archived first")

    # Pos 2 is currently active for the same instrument
    add_position(session, user_id=user.id, instrument_id=instrument.id, status="ACTIVE")

    # Attempting to restore pos1 back to ACTIVE must raise ValueError
    with pytest.raises(ValueError, match="An active position already exists for DUP_ACT."):
        restore_position(session, user_id=user.id, position_id=pos1.id)
