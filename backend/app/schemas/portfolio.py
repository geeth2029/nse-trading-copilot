from datetime import date, datetime
from decimal import Decimal, ROUND_FLOOR
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.base import APIModel


class UserRead(APIModel):
    id: str
    email: str
    display_name: str | None = None
    created_at: datetime


class InstrumentRead(APIModel):
    id: str
    canonical_symbol: str
    symbol: str
    display_name: str
    exchange: Literal["NSE"]
    is_large_cap: bool
    market_cap_rank: int | None = None
    sector: str | None = None
    is_active: bool


class TradeEntryRead(APIModel):
    id: str
    position_id: str
    sequence: int
    entry_type: Literal["INITIAL_ENTRY", "PYRAMID_ENTRY"]
    entry_date: date
    entry_price: float
    stop_loss: float
    rps: float
    rpt: float
    quantity: int | None
    capital_snapshot: float
    sizing_status: Literal["VALID", "INVALID_RPS_WARNING", "UNAVAILABLE"]
    entry_pnl: float | None = None
    notes: str | None = None


class TradeEntryCreate(APIModel):
    sequence: int = Field(gt=0)
    entry_type: Literal["INITIAL_ENTRY", "PYRAMID_ENTRY"]
    entry_date: date
    entry_price: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    stop_loss: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    rps: Decimal = Field(max_digits=18, decimal_places=4)
    rpt: Decimal = Field(ge=0, max_digits=18, decimal_places=4)
    quantity: int | None = Field(default=None, ge=0)
    capital_snapshot: Decimal = Field(ge=0, max_digits=18, decimal_places=4)
    sizing_status: Literal["VALID", "INVALID_RPS_WARNING", "UNAVAILABLE"]
    notes: str | None = None

    @model_validator(mode="after")
    def validate_sizing_snapshot(self) -> "TradeEntryCreate":
        if (self.sequence == 1) != (self.entry_type == "INITIAL_ENTRY"):
            raise ValueError("Sequence 1 must be the initial entry; later sequences must be pyramid entries.")

        if self.rps != self.entry_price - self.stop_loss:
            raise ValueError("RPS must equal entry price minus the recorded stop-loss.")

        if self.rpt != self.capital_snapshot * Decimal("0.01"):
            raise ValueError("RPT must equal 1% of the capital snapshot.")

        if self.sizing_status == "VALID":
            if self.capital_snapshot <= 0 or self.rps <= 0 or self.quantity is None or self.quantity <= 0:
                raise ValueError("Valid sizing requires positive capital, positive RPS, and a positive quantity (>= 1 share).")
            expected_quantity = int((self.rpt / self.rps).to_integral_value(rounding=ROUND_FLOOR))
            if expected_quantity <= 0:
                raise ValueError("Calculated quantity is zero shares; valid sizing requires at least 1 share.")
            if self.quantity != expected_quantity:
                raise ValueError("Quantity must equal floor(RPT / RPS) for valid sizing.")
        elif self.sizing_status == "INVALID_RPS_WARNING":
            if self.capital_snapshot <= 0 or self.rps > 0 or self.quantity is not None:
                raise ValueError("Invalid-RPS warning requires positive capital, non-positive RPS, and null quantity.")
        elif self.quantity is not None:
            raise ValueError("Unavailable sizing cannot contain a calculated quantity.")

        return self


class TradeEntryUpdate(APIModel):
    notes: str | None = None


class PositionExitRead(APIModel):
    id: str
    position_id: str
    exit_price: float
    exit_date: date
    recorded_at: datetime
    notes: str | None = None


class PortfolioPositionCreate(APIModel):
    symbol: str
    capital: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    notes: str | None = None
    initial_entry: TradeEntryCreate | None = None
    execution_price: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    confirm_reference_price_as_execution: bool = Field(default=False)
    acknowledge_invalid_rps: bool = Field(default=False)

    @model_validator(mode="after")
    def validate_inputs(self) -> "PortfolioPositionCreate":
        if self.capital is None and self.initial_entry is None:
            raise ValueError("Either capital or initial_entry must be provided.")
        return self


class PyramidEntryCreate(APIModel):
    capital: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    notes: str | None = None
    execution_price: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    confirm_reference_price_as_execution: bool = Field(default=False)
    acknowledge_invalid_rps: bool = Field(default=False)
    sequence: int | None = Field(default=None, gt=0)
    entry_type: Literal["INITIAL_ENTRY", "PYRAMID_ENTRY"] | None = None
    entry_date: date | None = None
    entry_price: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    stop_loss: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)
    rps: Decimal | None = Field(default=None, max_digits=18, decimal_places=4)
    rpt: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4)
    quantity: int | None = Field(default=None, ge=0)
    capital_snapshot: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4)
    sizing_status: Literal["VALID", "INVALID_RPS_WARNING", "UNAVAILABLE"] | None = None


class PositionExitCreate(APIModel):
    exit_price: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    exit_date: date
    notes: str | None = None


class PositionArchiveRequest(APIModel):
    reason: str | None = None



class PortfolioPositionRead(APIModel):
    id: str
    symbol: str
    company_name: str
    status: Literal["ACTIVE", "COMPLETED", "ARCHIVED"]
    initial_entry_date: date
    entries: list[TradeEntryRead]
    exit: PositionExitRead | None = None
    accumulated_quantity: int
    average_entry_price: float | None = None
    total_capital_deployed: float
    current_reference_price: float | None = None
    twenty_week_sma_stop_loss: float | None = None
    latest_weekly_rsi: float | None = None
    is_pyramid_eligible: bool | None = None
    realized_pnl: float | None = None
    unrealized_pnl: float | None = None
    archived_at: datetime | None = None
    archive_reason: str | None = None
    created_at: datetime


class PortfolioListRead(APIModel):
    positions: list[PortfolioPositionRead]


class HealthRead(APIModel):
    status: Literal["ok"]