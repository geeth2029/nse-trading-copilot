"""API router for read-only market data snapshots."""

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.dependencies.auth import (
    AuthenticatedSession,
    get_authenticated_session,
)
from app.schemas.market_data import MarketSnapshotRead
from app.schemas.universe import (
    UniverseConstituent,
    UniverseScreenResponse,
    UniverseStatusRead,
)
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MalformedDataError,
    MarketDataUnavailableError,
    ProviderAuthenticationError,
    RateLimitExceededError,
    StaleDataError,
)
from app.services.market_data.service import MarketDataService
from app.services.market_data.universe_screener import UniverseScreenerService
from app.services.market_data.universe_service import (
    UniverseNotAvailableError,
    UniverseService,
)

router = APIRouter(prefix="/api/v1/market-data", tags=["market-data"])


def get_market_data_service(request: Request) -> MarketDataService:
    service = getattr(request.app.state, "market_data_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Market data service is not configured on the application.",
        )
    return service


def get_universe_service(request: Request) -> UniverseService:
    service = getattr(request.app.state, "universe_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Universe service is not configured on the application.",
        )
    return service


def get_universe_screener_service(request: Request) -> UniverseScreenerService:
    service = getattr(request.app.state, "universe_screener_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Universe screener service is not configured on the application.",
        )
    return service


@router.get("/snapshot/{symbol}", response_model=MarketSnapshotRead)
async def get_market_snapshot(
    symbol: str,
    _authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    market_data_service: MarketDataService = Depends(get_market_data_service),
) -> MarketSnapshotRead:
    """Retrieve verified real-time reference quote and completed weekly indicators for an NSE equity symbol."""
    norm_symbol = symbol.strip().upper()

    try:
        snapshot = await market_data_service.get_market_snapshot(norm_symbol)
    except InstrumentNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{norm_symbol}' not found in verified market data: {exc}",
        ) from exc
    except ProviderAuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Market data provider authentication failed. Verified data is unavailable.",
        ) from exc
    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Market data provider rate limit exceeded. Please retry later.",
        ) from exc
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Verified market data is temporarily unavailable: {exc}",
        ) from exc
    except MalformedDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Invalid market data received: {exc}",
        ) from exc
    except StaleDataError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Market data for '{norm_symbol}' is stale: {exc}",
        ) from exc

    return MarketSnapshotRead(
        symbol=snapshot.symbol,
        instrument_identifier=snapshot.instrument_identifier,
        last_price=float(snapshot.last_price),
        quote_timestamp=snapshot.quote_timestamp,
        twenty_week_sma=float(snapshot.twenty_week_sma) if snapshot.twenty_week_sma is not None else None,
        weekly_rsi=float(snapshot.weekly_rsi) if snapshot.weekly_rsi is not None else None,
        latest_completed_candle_date=snapshot.latest_completed_candle_date,
        completed_candles_count=snapshot.completed_candles_count,
        is_stale=snapshot.is_stale,
        is_eligible_for_initial=snapshot.is_eligible_for_initial,
        status_reason=snapshot.status_reason,
        source=snapshot.source,
    )


@router.get("/universe/largecap/status", response_model=UniverseStatusRead)
async def get_largecap_universe_status(
    _authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    universe_service: UniverseService = Depends(get_universe_service),
) -> UniverseStatusRead:
    """Retrieve operational availability, integrity, and temporal validity status of the large-cap universe."""
    return universe_service.get_status()


@router.get("/universe/largecap/constituents", response_model=list[UniverseConstituent])
async def get_largecap_universe_constituents(
    _authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    universe_service: UniverseService = Depends(get_universe_service),
) -> list[UniverseConstituent]:
    """Retrieve verified constituents for the active large-cap universe.

    Requires an authenticated session. Constituents are served only when the large-cap
    universe passes all integrity validation and is currently active and valid.
    """
    try:
        return universe_service.get_constituents()
    except UniverseNotAvailableError as exc:
        u_status = exc.universe_status
        http_code = (
            status.HTTP_422_UNPROCESSABLE_ENTITY
            if u_status.status in ("EXPIRED", "NOT_YET_ACTIVE")
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        raise HTTPException(
            status_code=http_code,
            detail=f"Large-cap universe constituents cannot be served ({u_status.status}): {u_status.status_reason}",
            headers={"X-Universe-Status": u_status.status},
        ) from exc


@router.get("/universe/largecap/screen", response_model=UniverseScreenResponse)
async def screen_largecap_universe(
    qualified_only: bool = False,
    _authenticated: AuthenticatedSession = Depends(get_authenticated_session),
    screener_service: UniverseScreenerService = Depends(get_universe_screener_service),
) -> UniverseScreenResponse:
    """Screen the NSE Large-Cap Universe for constituents with Weekly RSI > 60.

    Requires an authenticated session. Screen is executed only when the large-cap universe
    passes all integrity validation and is currently active and valid.
    """
    try:
        return await screener_service.screen_universe(qualified_only=qualified_only)
    except UniverseNotAvailableError as exc:
        u_status = exc.universe_status
        http_code = (
            status.HTTP_422_UNPROCESSABLE_CONTENT
            if u_status.status in ("EXPIRED", "NOT_YET_ACTIVE")
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        raise HTTPException(
            status_code=http_code,
            detail=f"Large-cap universe screening cannot proceed ({u_status.status}): {u_status.status_reason}",
            headers={"X-Universe-Status": u_status.status},
        ) from exc
    except ProviderAuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Market data provider authentication failed. Screening cannot proceed.",
        ) from exc
    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Market data provider rate limit exceeded. Please retry later.",
        ) from exc
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Verified market data is temporarily unavailable: {exc}",
        ) from exc

