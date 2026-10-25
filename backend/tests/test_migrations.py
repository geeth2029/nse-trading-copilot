from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from app.database.session import make_engine

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def make_alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    config.attributes["database_url"] = database_url
    return config


def test_initial_migration_builds_model_schema_on_fresh_sqlite(tmp_path):
    database_url = f"sqlite:///{(tmp_path / 'migration-test.db').as_posix()}"
    config = make_alembic_config(database_url)

    command.upgrade(config, "head")

    engine = make_engine(database_url)
    try:
        inspector = inspect(engine)
        assert set(inspector.get_table_names()) == {
            "alembic_version",
            "instruments",
            "users",
            "auth_sessions",
            "portfolio_positions",
            "trade_entries",
            "position_exits",
        }
        assert {fk["referred_table"] for fk in inspector.get_foreign_keys("portfolio_positions")} == {
            "users",
            "instruments",
        }
        assert {fk["referred_table"] for fk in inspector.get_foreign_keys("auth_sessions")} == {"users"}
        assert inspector.get_unique_constraints("auth_sessions") == [
            {"name": None, "column_names": ["token_hash"]}
        ]
        assert inspector.get_unique_constraints("trade_entries") == [
            {
                "name": "uq_trade_entries_position_sequence",
                "column_names": ["position_id", "sequence"],
            }
        ]
        assert any(
            index["name"] == "uq_trade_entries_one_initial_per_position"
            and index["unique"]
            for index in inspector.get_indexes("trade_entries")
        )
        assert any(
            constraint["name"] == "ck_trade_entries_nonnegative_quantity"
            for constraint in inspector.get_check_constraints("trade_entries")
        )
        with engine.connect() as connection:
            current_revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        assert current_revision == "670bf16a5ea0"
    finally:
        engine.dispose()

    command.check(config)