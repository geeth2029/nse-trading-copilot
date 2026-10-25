from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.timestamps import TimestampMixin

if TYPE_CHECKING:
    from app.models.portfolio import PortfolioPosition


class Instrument(TimestampMixin, Base):
    __tablename__ = "instruments"
    __table_args__ = (
        UniqueConstraint("exchange", "symbol", name="uq_instruments_exchange_symbol"),
        CheckConstraint("exchange = 'NSE'", name="ck_instruments_nse_only"),
        CheckConstraint(
            "market_cap_rank IS NULL OR market_cap_rank BETWEEN 1 AND 100",
            name="ck_instruments_large_cap_rank",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    canonical_symbol: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    exchange: Mapped[str] = mapped_column(String(8), nullable=False, default="NSE", server_default="NSE")
    is_large_cap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    market_cap_rank: Mapped[int | None] = mapped_column()
    sector: Mapped[str | None] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    positions: Mapped[list["PortfolioPosition"]] = relationship(back_populates="instrument")