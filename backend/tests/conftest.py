from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from alembic import command
from alembic.config import Config
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.database.session import make_engine, make_session_factory
from app.main import create_app
from app.models import Instrument, PortfolioPosition, PositionExit, TradeEntry, User

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def upgrade_database(database_url: str) -> None:
    alembic_config = Config(str(BACKEND_ROOT / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    alembic_config.attributes["database_url"] = database_url
    command.upgrade(alembic_config, "head")


@pytest.fixture
def session() -> Generator[Session, None, None]:
    engine = make_engine("sqlite:///:memory:")
    # Keep unit fixtures isolated from the existing local database. Migration
    # behavior is exercised separately against temporary file-backed SQLite DBs.
    from app.database.base import Base

    Base.metadata.create_all(bind=engine)
    session_factory = make_session_factory(engine)
    with session_factory() as db_session:
        yield db_session
    engine.dispose()


@pytest.fixture
def client(tmp_path, registration_enabled=True) -> Generator[TestClient, None, None]:
    database_url = f"sqlite:///{(tmp_path / 'api-test.db').as_posix()}"
    upgrade_database(database_url)
    app = create_app(
        Settings(database_url=database_url, registration_enabled=registration_enabled)
    )
    with TestClient(app, base_url="https://testserver") as test_client:
        yield test_client


@pytest.fixture
def unverified_data_client(tmp_path, registration_enabled=True) -> Generator[TestClient, None, None]:
    """Isolated test client with explicit opt-in for testing internal snapshot calculations and lifecycles."""
    database_url = f"sqlite:///{(tmp_path / 'unverified-test.db').as_posix()}"
    upgrade_database(database_url)
    app = create_app(
        Settings(
            database_url=database_url,
            registration_enabled=registration_enabled,
            allow_unverified_market_data=True,
        )
    )
    with TestClient(app, base_url="https://testserver") as test_client:
        yield test_client