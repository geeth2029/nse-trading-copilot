from datetime import date

from app.models import Instrument, PortfolioPosition, User
from app.repositories.portfolio import get_position_for_user, list_positions_for_user


def test_portfolio_queries_are_scoped_to_owner(session):
    owner = User(email="owner@example.test", password_hash="argon2$test-hash")
    other_user = User(email="other@example.test", password_hash="argon2$test-hash")
    instrument = Instrument(
        canonical_symbol="RELIANCE.NS",
        symbol="RELIANCE",
        display_name="Reliance Industries Ltd",
        exchange="NSE",
        is_large_cap=True,
        market_cap_rank=1,
    )
    session.add_all([owner, other_user, instrument])
    session.flush()

    owner_position = PortfolioPosition(
        user_id=owner.id,
        instrument_id=instrument.id,
        status="ACTIVE",
        initial_entry_date=date(2026, 10, 24),
    )
    other_position = PortfolioPosition(
        user_id=other_user.id,
        instrument_id=instrument.id,
        status="ACTIVE",
        initial_entry_date=date(2026, 10, 24),
    )
    session.add_all([owner_position, other_position])
    session.flush()

    assert [position.id for position in list_positions_for_user(session, user_id=owner.id)] == [
        owner_position.id
    ]
    assert get_position_for_user(
        session, user_id=owner.id, position_id=other_position.id
    ) is None
    assert get_position_for_user(
        session, user_id=other_user.id, position_id=other_position.id
    ) is not None