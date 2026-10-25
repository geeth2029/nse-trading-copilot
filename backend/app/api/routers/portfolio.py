from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies.auth import (
    AuthenticatedSession,
    get_authenticated_session,
    require_csrf,
)
from app.database.session import get_db
from app.models.instrument import Instrument
from app.models.portfolio import PortfolioPosition
from app.repositories.portfolio import get_position_for_user, list_positions_for_user
from app.schemas.portfolio import (
    PortfolioListRead,
    PortfolioPositionCreate,
    PortfolioPositionRead,
    PositionArchiveRequest,
    PositionExitCreate,
    PositionExitRead,
    PyramidEntryCreate,
    TradeEntryCreate,
    TradeEntryRead,
)
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MalformedDataError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
    StaleDataError,
)
from app.services.market_data.service import (
    derive_initial_entry,
    derive_pyramid_entry,
)
from app.services.portfolio import (
    PositionNotFoundError,
    archive_position,
    create_position,
    create_trade_entry,
    record_position_exit,
    restore_position,
)
from app.services.portfolio_calculations import summarize_position

router = APIRouter(prefix="/api/v1/portfolio", tags=["portfolio"])
PositionStatus = Literal["ACTIVE", "COMPLETED", "ARCHIVED"]


def serialize_position(position: PortfolioPosition) -> PortfolioPositionRead:
    exit_price = position.exit.exit_price if position.exit is not None else None
    sorted_entries = sorted(position.entries, key=lambda entry: entry.sequence)
    summary = summarize_position(sorted_entries, exit_price=exit_price)
    entry_pnls = summary.entry_pnls

    entries = [
        TradeEntryRead.model_validate(entry).model_copy(
            update={"entry_pnl": float(entry_pnls[index]) if entry_pnls[index] is not None else None}
        )
        for index, entry in enumerate(sorted_entries)
    ]

    return PortfolioPositionRead(
        id=position.id,
        symbol=position.instrument.symbol,
        company_name=position.instrument.display_name,
        status=position.status,
        initial_entry_date=position.initial_entry_date,
        entries=entries,
        exit=PositionExitRead.model_validate(position.exit) if position.exit else None,
        accumulated_quantity=summary.accumulated_quantity,
        average_entry_price=float(summary.average_entry_price),
        total_capital_deployed=float(summary.total_capital_deployed),
        current_reference_price=None,
        twenty_week_sma_stop_loss=None,
        latest_weekly_rsi=None,
        is_pyramid_eligible=None,
        realized_pnl=float(summary.consolidated_pnl) if summary.consolidated_pnl is not None else None,
        unrealized_pnl=None,
        archived_at=position.archived_at,
        archive_reason=position.archive_reason,
        created_at=position.created_at,
    )


@router.get("/positions", response_model=PortfolioListRead)
def read_positions(
    status_filter: PositionStatus | None = Query(default=None, alias="status"),
    authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    db: Session = Depends(get_db),
) -> PortfolioListRead:
    positions = list_positions_for_user(db, user_id=authenticated.user.id, include_archived=True)
    if status_filter is not None:
        positions = [position for position in positions if position.status == status_filter]
    return PortfolioListRead(positions=[serialize_position(position) for position in positions])


@router.get("/positions/{position_id}", response_model=PortfolioPositionRead)
def read_position(
    position_id: str,
    authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    position = get_position_for_user(db, user_id=authenticated.user.id, position_id=position_id)
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")
    return serialize_position(position)


@router.post(
    "/positions",
    response_model=PortfolioPositionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_initial_position(
    body: PortfolioPositionCreate,
    request: Request,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    allow_unverified = request.app.state.settings.allow_unverified_market_data

    # Legacy branch for explicit test opt-in fixtures
    if allow_unverified and body.initial_entry is not None:
        normalized_symbol = str(body.symbol).strip().upper()
        instrument = db.scalar(
            select(Instrument).where(
                (Instrument.symbol == normalized_symbol)
                | (Instrument.canonical_symbol == normalized_symbol)
                | (Instrument.canonical_symbol == f"{normalized_symbol}.NS")
            )
        )
        if instrument is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Instrument '{body.symbol}' not found.",
            )

        existing_active = db.scalar(
            select(PortfolioPosition).where(
                PortfolioPosition.user_id == authenticated.user.id,
                PortfolioPosition.instrument_id == instrument.id,
                PortfolioPosition.status == "ACTIVE",
            )
        )
        if existing_active is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"An active position already exists for {instrument.symbol}.",
            )

        if body.initial_entry.sequence != 1 or body.initial_entry.entry_type != "INITIAL_ENTRY":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Initial entry must have sequence 1 and entry_type 'INITIAL_ENTRY'.",
            )

        try:
            position = create_position(
                db,
                user_id=authenticated.user.id,
                instrument_id=instrument.id,
                initial_entry=body.initial_entry,
            )
            db.commit()
        except ValueError as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc

        created = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
        return serialize_position(created)

    # Server-authoritative verified market data branch
    capital = body.capital or (body.initial_entry.capital_snapshot if body.initial_entry else None)
    if capital is None or capital <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Positive capital is required to create a position.",
        )

    # Verify symbol belongs to active, valid, verified AMFI large-cap universe
    universe_service = getattr(request.app.state, "universe_service", None)
    if universe_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Universe service is not configured.",
        )

    u_status = universe_service.get_status()
    if u_status.status != "VALID":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"AMFI large-cap universe is not active or valid ({u_status.status}): {u_status.status_reason}",
        )

    constituents = universe_service.get_constituents()
    normalized_symbol = str(body.symbol).strip().upper()
    constituent = next(
        (c for c in constituents if c.canonical_nse_symbol.upper() == normalized_symbol),
        None,
    )
    if constituent is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Symbol '{normalized_symbol}' is not an active constituent of the validated AMFI large-cap universe.",
        )

    market_data_service = getattr(request.app.state, "market_data_service", None)
    if market_data_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Market data service is not configured.",
        )

    try:
        snapshot = await market_data_service.get_market_snapshot(normalized_symbol)
    except ProviderAuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated entry creation is temporarily unavailable because verified NSE market data has not been connected.",
        ) from exc
    except InstrumentNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{body.symbol}' not found: {exc}",
        ) from exc
    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Market data provider rate limit exceeded. Please retry later.",
        ) from exc
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Verified market data unavailable: {exc}",
        ) from exc
    except MalformedDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Invalid market data received: {exc}",
        ) from exc
    except StaleDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Market data is stale: {exc}",
        ) from exc

    try:
        notes = body.notes or (body.initial_entry.notes if body.initial_entry else None)
        derived_entry = derive_initial_entry(
            snapshot,
            capital=capital,
            notes=notes,
            execution_price=body.execution_price,
            confirm_reference_price_as_execution=body.confirm_reference_price_as_execution,
            acknowledge_invalid_rps=body.acknowledge_invalid_rps,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    instrument = db.scalar(
        select(Instrument).where(
            (Instrument.symbol == normalized_symbol)
            | (Instrument.canonical_symbol == normalized_symbol)
            | (Instrument.canonical_symbol == f"{normalized_symbol}.NS")
        )
    )
    if instrument is None:
        instrument = Instrument(
            symbol=normalized_symbol,
            canonical_symbol=f"{normalized_symbol}.NS",
            display_name=constituent.company_name,
            exchange="NSE",
            is_large_cap=True,
            market_cap_rank=constituent.rank,
            is_active=True,
        )
        db.add(instrument)
        db.flush()
    else:
        if not instrument.is_large_cap or instrument.market_cap_rank != constituent.rank:
            instrument.is_large_cap = True
            instrument.market_cap_rank = constituent.rank
            db.flush()

    existing_active = db.scalar(
        select(PortfolioPosition).where(
            PortfolioPosition.user_id == authenticated.user.id,
            PortfolioPosition.instrument_id == instrument.id,
            PortfolioPosition.status == "ACTIVE",
        )
    )
    if existing_active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An active position already exists for {instrument.symbol}.",
        )

    try:
        position = create_position(
            db,
            user_id=authenticated.user.id,
            instrument_id=instrument.id,
            initial_entry=derived_entry,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    created = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
    return serialize_position(created)


@router.post(
    "/positions/{position_id}/entries",
    response_model=PortfolioPositionRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_pyramid_entry(
    position_id: str,
    body: PyramidEntryCreate,
    request: Request,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    position = get_position_for_user(db, user_id=authenticated.user.id, position_id=position_id)
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")

    if position.status != "ACTIVE" or position.exit is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot add pyramid entries to an exited or archived position.",
        )

    allow_unverified = request.app.state.settings.allow_unverified_market_data

    # Legacy branch for explicit test opt-in fixtures
    if allow_unverified and body.sequence is not None and body.entry_type is not None:
        next_sequence = len(position.entries) + 1
        if body.sequence != next_sequence or body.entry_type != "PYRAMID_ENTRY":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Pyramid entry must have sequence {next_sequence} and entry_type 'PYRAMID_ENTRY'.",
            )

        try:
            legacy_entry = TradeEntryCreate.model_validate(body.model_dump())
            create_trade_entry(
                db,
                user_id=authenticated.user.id,
                position_id=position.id,
                entry_data=legacy_entry,
            )
            db.commit()
        except PositionNotFoundError:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")
        except ValueError as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc

        updated = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
        return serialize_position(updated)

    # Server-authoritative verified market data branch
    capital = body.capital or body.capital_snapshot
    if capital is None or capital <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Positive capital is required for pyramid entry.",
        )

    symbol = position.instrument.symbol

    # Verify symbol belongs to active, valid, verified AMFI large-cap universe
    universe_service = getattr(request.app.state, "universe_service", None)
    if universe_service is not None:
        u_status = universe_service.get_status()
        if u_status.status != "VALID":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"AMFI large-cap universe is not active or valid ({u_status.status}): {u_status.status_reason}",
            )
        constituents = universe_service.get_constituents()
        norm_sym = symbol.strip().upper()
        if not any(c.canonical_nse_symbol.upper() == norm_sym for c in constituents):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Symbol '{norm_sym}' is no longer an active constituent of the validated AMFI large-cap universe.",
            )

    sorted_entries = sorted(position.entries, key=lambda e: e.sequence)
    previous_entry = sorted_entries[-1]
    previous_entry_price = Decimal(str(previous_entry.entry_price))
    next_sequence = len(position.entries) + 1

    market_data_service = getattr(request.app.state, "market_data_service", None)
    if market_data_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Market data service is not configured.",
        )

    try:
        snapshot = await market_data_service.get_market_snapshot(symbol)
    except ProviderAuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated pyramid entry is temporarily unavailable because verified NSE market data has not been connected.",
        ) from exc
    except InstrumentNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{symbol}' not found: {exc}",
        ) from exc
    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Market data provider rate limit exceeded. Please retry later.",
        ) from exc
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Verified market data unavailable: {exc}",
        ) from exc
    except MalformedDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Invalid market data received: {exc}",
        ) from exc
    except StaleDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Market data is stale: {exc}",
        ) from exc

    try:
        derived_pyramid = derive_pyramid_entry(
            snapshot,
            capital=capital,
            previous_entry_price=previous_entry_price,
            next_sequence=next_sequence,
            notes=body.notes,
            execution_price=body.execution_price,
            confirm_reference_price_as_execution=body.confirm_reference_price_as_execution,
            acknowledge_invalid_rps=body.acknowledge_invalid_rps,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    try:
        create_trade_entry(
            db,
            user_id=authenticated.user.id,
            position_id=position.id,
            entry_data=derived_pyramid,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    updated = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
    return serialize_position(updated)


@router.post(
    "/positions/{position_id}/exit",
    response_model=PortfolioPositionRead,
    status_code=status.HTTP_200_OK,
)
def record_exit(
    position_id: str,
    body: PositionExitCreate,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    position = get_position_for_user(db, user_id=authenticated.user.id, position_id=position_id)
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")

    if position.exit is not None or position.status == "COMPLETED":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An exit has already been recorded for this position.",
        )

    if position.status == "ARCHIVED":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot record an exit on an archived position.",
        )

    if body.exit_date < position.initial_entry_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Exit date cannot precede initial entry date.",
        )

    try:
        record_position_exit(
            db,
            user_id=authenticated.user.id,
            position_id=position.id,
            exit_price=body.exit_price,
            exit_date=body.exit_date,
            notes=body.notes,
        )
        db.commit()
    except PositionNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    updated = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
    return serialize_position(updated)


@router.post(
    "/positions/{position_id}/archive",
    response_model=PortfolioPositionRead,
    status_code=status.HTTP_200_OK,
)
def archive_user_position(
    position_id: str,
    body: PositionArchiveRequest | None = None,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    position = get_position_for_user(db, user_id=authenticated.user.id, position_id=position_id)
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")

    try:
        archive_position(
            db,
            user_id=authenticated.user.id,
            position_id=position_id,
            reason=body.reason if body else None,
        )
        db.commit()
    except PositionNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")

    updated = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
    return serialize_position(updated)


@router.post(
    "/positions/{position_id}/restore",
    response_model=PortfolioPositionRead,
    status_code=status.HTTP_200_OK,
)
def restore_user_position(
    position_id: str,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> PortfolioPositionRead:
    position = get_position_for_user(db, user_id=authenticated.user.id, position_id=position_id)
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")

    if position.status != "ARCHIVED":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot restore a position that is not archived.",
        )

    try:
        restore_position(
            db,
            user_id=authenticated.user.id,
            position_id=position_id,
        )
        db.commit()
    except PositionNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found.")
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    updated = get_position_for_user(db, user_id=authenticated.user.id, position_id=position.id)
    return serialize_position(updated)
