from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routers.auth import router as auth_router
from app.api.routers.health import router as health_router
from app.api.routers.market_data import router as market_data_router
from app.api.routers.portfolio import router as portfolio_router
from app.core.config import Settings
from app.database.session import make_engine, make_session_factory
from app.services.market_data.factory import create_market_data_provider
from app.services.market_data.service import MarketDataService
from app.services.market_data.universe_screener import UniverseScreenerService
from app.services.market_data.universe_service import UniverseService


def create_app(
    settings: Settings | None = None,
    market_data_service: MarketDataService | None = None,
    universe_service: UniverseService | None = None,
    universe_screener_service: UniverseScreenerService | None = None,
) -> FastAPI:
    app_settings = settings or Settings.from_environment()
    engine = make_engine(app_settings.database_url)
    session_factory = make_session_factory(engine)

    md_service = market_data_service or MarketDataService(
        provider=create_market_data_provider(settings=app_settings)
    )
    u_service = universe_service or UniverseService(settings=app_settings)
    u_screener_service = universe_screener_service or UniverseScreenerService(
        universe_service=u_service,
        provider=md_service.provider,
        settings=app_settings,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        engine.dispose()

    app = FastAPI(title=app_settings.app_name, lifespan=lifespan)
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.settings = app_settings
    app.state.market_data_service = md_service
    app.state.universe_service = u_service
    app.state.universe_screener_service = u_screener_service

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(portfolio_router)
    app.include_router(market_data_router)
    return app


app = create_app()