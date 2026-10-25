from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy import inspect

from app.database.base import Base
from app.database.session import make_engine
from app.models import PortfolioPosition, PositionExit
from tests.factories import add_instrument, add_position, add_user, make_entry


def test_initial_tables_can_be_created():
    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)

    assert set(inspect(engine).get_table_names()) == {
        "users",
        "auth_sessions",
        "instruments",
        "portfolio_positions",
        "trade_entries",
        "position_exits",
    }
    engine.dispose()


def test_duplicate_entry_sequence_is_rejected(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id)
    session.add(make_entry(position.id, 1))
    session.flush()
    session.add(make_entry(position.id, 1, entry_type="PYRAMID_ENTRY"))

    with pytest.raises(IntegrityError):
        session.flush()


def test_second_initial_entry_is_rejected(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id)
    session.add(make_entry(position.id, 1))
    session.flush()
    session.add(make_entry(position.id, 2, entry_type="INITIAL_ENTRY"))

    with pytest.raises(IntegrityError):
        session.flush()


def test_second_exit_for_position_is_rejected(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id)
    session.add_all(
        [
            PositionExit(position_id=position.id, exit_price=Decimal("120"), exit_date=date(2026, 10, 10)),
            PositionExit(position_id=position.id, exit_price=Decimal("125"), exit_date=date(2026, 10, 11)),
        ]
    )

    with pytest.raises(IntegrityError):
        session.flush()


def test_negative_quantity_is_rejected(session):
    user = add_user(session)
    instrument = add_instrument(session)
    position = add_position(session, user_id=user.id, instrument_id=instrument.id)
    session.add(make_entry(position.id, 1, quantity=-1))

    with pytest.raises(IntegrityError):
        session.flush()


def test_foreign_keys_reject_unknown_position_owner(session):
    instrument = add_instrument(session)
    position = PortfolioPosition(
        user_id="missing-user",
        instrument_id=instrument.id,
        status="ACTIVE",
        initial_entry_date=date(2026, 10, 1),
    )
    session.add(position)

    with pytest.raises(IntegrityError):
        session.flush()


def test_foreign_keys_restrict_deleting_user_with_position(session):
    user = add_user(session)
    instrument = add_instrument(session)
    add_position(session, user_id=user.id, instrument_id=instrument.id)
    session.delete(user)

    with pytest.raises(IntegrityError):
        session.flush()