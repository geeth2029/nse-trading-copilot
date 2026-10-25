from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

from app.core.config import Settings
from app.database.base import Base
from app.database.session import make_engine
from app.models import Instrument, PortfolioPosition, PositionExit, TradeEntry, User

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = Settings.from_environment()
database_url = config.attributes.get("database_url", settings.database_url)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=database_url.startswith("sqlite"),
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=connection.dialect.name == "sqlite",
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = make_engine(database_url)
    try:
        with engine.connect() as connection:
            do_run_migrations(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()