from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.portfolio import PortfolioPosition


def list_positions_for_user(
    session: Session,
    *,
    user_id: str,
    include_archived: bool = True,
) -> list[PortfolioPosition]:
    """List positions only within an explicitly supplied owner scope."""
    statement = (
        select(PortfolioPosition)
        .where(PortfolioPosition.user_id == user_id)
        .options(
            selectinload(PortfolioPosition.instrument),
            selectinload(PortfolioPosition.entries),
            selectinload(PortfolioPosition.exit),
        )
        .order_by(PortfolioPosition.created_at.desc())
    )
    if not include_archived:
        statement = statement.where(PortfolioPosition.status != "ARCHIVED")
    return list(session.scalars(statement).unique())


def get_position_for_user(
    session: Session,
    *,
    user_id: str,
    position_id: str,
) -> PortfolioPosition | None:
    """Fetch one position only if it belongs to the supplied owner."""
    statement = (
        select(PortfolioPosition)
        .where(
            PortfolioPosition.id == position_id,
            PortfolioPosition.user_id == user_id,
        )
        .options(
            selectinload(PortfolioPosition.instrument),
            selectinload(PortfolioPosition.entries),
            selectinload(PortfolioPosition.exit),
        )
    )
    return session.scalars(statement).unique().one_or_none()