from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.models.timestamps import TimestampMixin

if TYPE_CHECKING:
    from app.models.instrument import Instrument
    from app.models.user import User


class PortfolioPosition(TimestampMixin, Base):
    __tablename__ = "portfolio_positions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('ACTIVE', 'COMPLETED', 'ARCHIVED')",
            name="ck_positions_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    instrument_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("instruments.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ACTIVE", server_default="ACTIVE")
    initial_entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archive_reason: Mapped[str | None] = mapped_column(Text)

    user: Mapped["User"] = relationship(back_populates="positions")
    instrument: Mapped["Instrument"] = relationship(back_populates="positions")
    entries: Mapped[list["TradeEntry"]] = relationship(
        back_populates="position", order_by="TradeEntry.sequence"
    )
    exit: Mapped["PositionExit | None"] = relationship(back_populates="position", uselist=False)

    @property
    def symbol(self) -> str:
        return self.instrument.symbol

    @property
    def company_name(self) -> str:
        return self.instrument.display_name


class TradeEntry(TimestampMixin, Base):
    __tablename__ = "trade_entries"
    __table_args__ = (
        UniqueConstraint("position_id", "sequence", name="uq_trade_entries_position_sequence"),
        CheckConstraint("sequence > 0", name="ck_trade_entries_positive_sequence"),
        CheckConstraint("entry_type IN ('INITIAL_ENTRY', 'PYRAMID_ENTRY')", name="ck_trade_entries_type"),
        CheckConstraint(
            "sizing_status IN ('VALID', 'INVALID_RPS_WARNING', 'UNAVAILABLE')",
            name="ck_trade_entries_sizing_status",
        ),
        CheckConstraint("entry_price > 0", name="ck_trade_entries_positive_entry_price"),
        CheckConstraint("stop_loss > 0", name="ck_trade_entries_positive_stop_loss"),
        CheckConstraint("rpt >= 0", name="ck_trade_entries_nonnegative_rpt"),
        CheckConstraint("capital_snapshot >= 0", name="ck_trade_entries_nonnegative_capital"),
        CheckConstraint("quantity IS NULL OR quantity >= 0", name="ck_trade_entries_nonnegative_quantity"),
        Index(
            "uq_trade_entries_one_initial_per_position",
            "position_id",
            unique=True,
            sqlite_where=text("entry_type = 'INITIAL_ENTRY'"),
            postgresql_where=text("entry_type = 'INITIAL_ENTRY'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    position_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("portfolio_positions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_type: Mapped[str] = mapped_column(String(20), nullable=False)
    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    stop_loss: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    rps: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    rpt: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    quantity: Mapped[int | None] = mapped_column(Integer)
    capital_snapshot: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    sizing_status: Mapped[str] = mapped_column(String(24), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)

    position: Mapped["PortfolioPosition"] = relationship(back_populates="entries")


class PositionExit(TimestampMixin, Base):
    __tablename__ = "position_exits"
    __table_args__ = (
        UniqueConstraint("position_id", name="uq_position_exits_position"),
        CheckConstraint("exit_price > 0", name="ck_position_exits_positive_price"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    position_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("portfolio_positions.id", ondelete="RESTRICT"), nullable=False
    )
    exit_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    exit_date: Mapped[date] = mapped_column(Date, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    notes: Mapped[str | None] = mapped_column(Text)

    position: Mapped["PortfolioPosition"] = relationship(back_populates="exit")