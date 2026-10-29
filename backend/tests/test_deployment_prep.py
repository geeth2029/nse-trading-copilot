"""
Deployment-preparation regression tests.

Covers:
- PostgreSQL partial index correctness (model + migration)
- CORS middleware configuration
- allow_origin enforcement (Vercel proxy origin accepted; attacker origin rejected)
- require_same_origin with proxy origin
- Session cookies remain SameSite=Lax (no regression)
- CSRF protection survives proxy-forwarded requests
- Environment variable configuration for ALLOWED_ORIGIN
- TEJ market-data startup guard: screen endpoint 503s while partitions still downloading
- Migration: new Alembic revision is present in the chain
"""

from __future__ import annotations

import importlib
import threading
from contextlib import contextmanager
from http.cookies import SimpleCookie
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text

from app.core.config import Settings
from app.database.session import make_engine, make_session_factory
from app.main import create_app

BACKEND_ROOT = Path(__file__).resolve().parents[1]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _upgrade(database_url: str) -> None:
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    cfg.attributes["database_url"] = database_url
    command.upgrade(cfg, "head")


@contextmanager
def _make_client(
    tmp_path,
    *,
    allowed_origin: str = "https://testserver",
    registration_enabled: bool = True,
    extra_settings: dict | None = None,
):
    db_url = f"sqlite:///{(tmp_path / 'deploy-test.db').as_posix()}"
    _upgrade(db_url)
    settings = Settings(
        database_url=db_url,
        registration_enabled=registration_enabled,
        allowed_origin=allowed_origin,
        **(extra_settings or {}),
    )
    app = create_app(settings=settings)
    # TestClient base_url is the "backend" URL; allowed_origin is the "frontend" URL
    with TestClient(app, base_url="https://backend.onrender.com") as client:
        yield client


def _register(client: TestClient, origin: str) -> dict:
    r = client.post(
        "/auth/register",
        headers={"Origin": origin},
        json={"email": "user@example.com", "password": "secret-password-123"},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _cookie(client: TestClient, name: str) -> str | None:
    return client.cookies.get(name)


# ─────────────────────────────────────────────────────────────────────────────
# 1. PostgreSQL partial index — model definition
# ─────────────────────────────────────────────────────────────────────────────


def test_trade_entry_model_has_both_dialect_where_predicates():
    """The partial index must carry both sqlite_where and postgresql_where."""
    from app.models.portfolio import TradeEntry
    from sqlalchemy import Index

    table_args = TradeEntry.__table_args__
    partial_indexes = [
        arg for arg in table_args
        if isinstance(arg, Index)
        and arg.name == "uq_trade_entries_one_initial_per_position"
    ]
    assert len(partial_indexes) == 1, "Expected exactly one partial index for INITIAL_ENTRY"
    idx = partial_indexes[0]
    assert idx.dialect_kwargs.get("sqlite_where") is not None, "sqlite_where predicate missing"
    assert idx.dialect_kwargs.get("postgresql_where") is not None, "postgresql_where predicate missing"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Migration chain — new revision present
# ─────────────────────────────────────────────────────────────────────────────


def test_new_partial_index_migration_is_present_in_chain(tmp_path):
    """The PostgreSQL partial-index repair migration must exist in the Alembic chain."""
    db_url = f"sqlite:///{(tmp_path / 'chain-test.db').as_posix()}"
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    cfg.attributes["database_url"] = db_url

    from alembic.script import ScriptDirectory
    script_dir = ScriptDirectory.from_config(cfg)
    revisions = {s.revision for s in script_dir.walk_revisions()}
    assert "a1b2c3d4e5f6" in revisions, (
        "Migration a1b2c3d4e5f6 (fix_partial_index_postgresql) not found in chain. "
        "Check alembic/versions/."
    )


def test_sqlite_migration_applies_to_head_with_new_revision(tmp_path):
    """alembic upgrade head on SQLite must succeed and reach the new revision."""
    db_url = f"sqlite:///{(tmp_path / 'full-chain.db').as_posix()}"
    _upgrade(db_url)

    engine = make_engine(db_url)
    try:
        with engine.connect() as conn:
            rev = conn.scalar(text("SELECT version_num FROM alembic_version"))
        assert rev == "a1b2c3d4e5f6", f"Expected head revision a1b2c3d4e5f6, got {rev}"
    finally:
        engine.dispose()


def test_partial_index_exists_after_full_sqlite_migration(tmp_path):
    """After running all migrations the partial index must still be present."""
    db_url = f"sqlite:///{(tmp_path / 'index-check.db').as_posix()}"
    _upgrade(db_url)

    engine = make_engine(db_url)
    try:
        inspector = inspect(engine)
        indexes = inspector.get_indexes("trade_entries")
        partial = next(
            (i for i in indexes if i["name"] == "uq_trade_entries_one_initial_per_position"),
            None,
        )
        assert partial is not None, "Partial index uq_trade_entries_one_initial_per_position missing after migration"
        assert bool(partial["unique"]) is True, "Partial index must be unique"
    finally:
        engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# 3. CORS middleware
# ─────────────────────────────────────────────────────────────────────────────


def test_cors_allowed_origin_header_returned_for_configured_origin(tmp_path):
    """CORS: backend must echo back the configured allowed origin."""
    with _make_client(tmp_path, allowed_origin="https://myapp.vercel.app") as client:
        r = client.options(
            "/health",
            headers={
                "Origin": "https://myapp.vercel.app",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert r.headers.get("access-control-allow-origin") == "https://myapp.vercel.app"
        assert r.headers.get("access-control-allow-credentials") == "true"


def test_cors_unknown_origin_not_reflected(tmp_path):
    """CORS: attacker origin must NOT be reflected in Allow-Origin header."""
    with _make_client(tmp_path, allowed_origin="https://myapp.vercel.app") as client:
        r = client.options(
            "/health",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        # Either no header or must not contain the attacker origin
        acao = r.headers.get("access-control-allow-origin", "")
        assert "evil.example.com" not in acao


# ─────────────────────────────────────────────────────────────────────────────
# 4. require_same_origin with proxy origin
# ─────────────────────────────────────────────────────────────────────────────


def test_register_accepted_with_configured_allowed_origin(tmp_path):
    """register must succeed when Origin matches the configured allowed_origin (Vercel proxy)."""
    frontend_origin = "https://myapp.vercel.app"
    with _make_client(tmp_path, allowed_origin=frontend_origin) as client:
        r = client.post(
            "/auth/register",
            headers={"Origin": frontend_origin},
            json={"email": "user@example.com", "password": "secret-password-123"},
        )
        assert r.status_code == 201


def test_register_accepted_with_backend_same_origin(tmp_path):
    """register must succeed when Origin matches the backend base_url (local / direct access)."""
    with _make_client(tmp_path, allowed_origin="https://myapp.vercel.app") as client:
        # TestClient base_url is https://backend.onrender.com — same-origin check passes
        r = client.post(
            "/auth/register",
            headers={"Origin": "https://backend.onrender.com"},
            json={"email": "user@example.com", "password": "secret-password-123"},
        )
        assert r.status_code == 201


def test_register_rejected_with_attacker_origin(tmp_path):
    """register must be rejected when Origin is neither backend nor allowed_origin."""
    with _make_client(tmp_path, allowed_origin="https://myapp.vercel.app") as client:
        r = client.post(
            "/auth/register",
            headers={"Origin": "https://attacker.example.com"},
            json={"email": "user@example.com", "password": "secret-password-123"},
        )
        assert r.status_code == 403


def test_register_rejected_with_no_origin(tmp_path):
    """register must be rejected when no Origin header is present."""
    with _make_client(tmp_path, allowed_origin="https://myapp.vercel.app") as client:
        r = client.post(
            "/auth/register",
            json={"email": "user@example.com", "password": "secret-password-123"},
        )
        assert r.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# 5. Session cookie SameSite=Lax preserved (no regression)
# ─────────────────────────────────────────────────────────────────────────────


def test_session_cookie_still_samesite_lax_after_cors_changes(tmp_path):
    """SameSite must remain Lax — Vercel rewrites keep the browser on the same domain."""
    frontend_origin = "https://myapp.vercel.app"
    with _make_client(tmp_path, allowed_origin=frontend_origin) as client:
        r = client.post(
            "/auth/register",
            headers={"Origin": frontend_origin},
            json={"email": "user@example.com", "password": "secret-password-123"},
        )
        assert r.status_code == 201
        session_cookie_header = next(
            h for h in r.headers.get_list("set-cookie") if "nse_session=" in h
        )
        parsed = SimpleCookie()
        parsed.load(session_cookie_header)
        morsel = parsed["nse_session"]
        assert morsel["samesite"].lower() == "lax", (
            "SameSite must remain Lax. Vercel rewrites keep the browser on the "
            "Vercel domain so Lax cookies are transmitted without SameSite=None."
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Full proxy-origin auth flow: login → authenticated read → CSRF write → logout
# ─────────────────────────────────────────────────────────────────────────────


def test_full_auth_flow_via_proxy_origin(tmp_path):
    """Simulate the Vercel → Render proxy: all state-changing requests carry the
    frontend Origin.  The flow must complete: register → me → CSRF write → logout."""
    frontend_origin = "https://myapp.vercel.app"
    with _make_client(tmp_path, allowed_origin=frontend_origin) as client:
        # Register
        r = client.post(
            "/auth/register",
            headers={"Origin": frontend_origin},
            json={"email": "trader@example.com", "password": "password-abc-123"},
        )
        assert r.status_code == 201

        # Read current user (no CSRF needed — GET)
        me = client.get("/auth/me")
        assert me.status_code == 200
        assert me.json()["email"] == "trader@example.com"

        # CSRF-protected write — logout
        csrf_token = _cookie(client, "nse_csrf")
        logout_r = client.post(
            "/auth/logout",
            headers={"Origin": frontend_origin, "x-csrf-token": csrf_token},
        )
        assert logout_r.status_code == 200
        assert logout_r.json() == {"status": "logged_out"}

        # Session must be gone
        assert client.get("/auth/me").status_code == 401


def test_csrf_rejected_when_header_missing_via_proxy_origin(tmp_path):
    """CSRF protection must still fire even when Origin is the trusted frontend."""
    frontend_origin = "https://myapp.vercel.app"
    with _make_client(tmp_path, allowed_origin=frontend_origin) as client:
        client.post(
            "/auth/register",
            headers={"Origin": frontend_origin},
            json={"email": "trader@example.com", "password": "password-abc-123"},
        )
        # Missing x-csrf-token → 403
        r = client.post(
            "/auth/logout",
            headers={"Origin": frontend_origin},
        )
        assert r.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# 7. Settings — ALLOWED_ORIGIN is read from environment
# ─────────────────────────────────────────────────────────────────────────────


def test_settings_reads_allowed_origin_from_environment(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://custom-app.vercel.app")
    settings = Settings.from_environment()
    assert settings.allowed_origin == "https://custom-app.vercel.app"


def test_settings_allowed_origin_default_is_localhost():
    s = Settings()
    assert s.allowed_origin.startswith("http://localhost")


def test_settings_allowed_origin_not_wildcard(monkeypatch):
    """Confirm we never ship a wildcard as the allowed origin."""
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://myapp.vercel.app")
    settings = Settings.from_environment()
    assert "*" not in settings.allowed_origin


# ─────────────────────────────────────────────────────────────────────────────
# 8. TEJ market-data startup guard
#    Screen endpoint must return 503 when partitions are still downloading.
# ─────────────────────────────────────────────────────────────────────────────


def test_screener_returns_503_when_partitions_unavailable(tmp_path):
    """If TEJ partitions are absent and auto_sync is disabled the screener must
    return 503 (MarketDataUnavailableError path) rather than serving stale or
    empty data.  This guards against the first-request qualification race."""
    from app.services.market_data.errors import MarketDataUnavailableError
    from app.services.market_data.universe_screener import UniverseScreenerService

    db_url = f"sqlite:///{(tmp_path / 'startup-test.db').as_posix()}"
    _upgrade(db_url)

    settings = Settings(
        database_url=db_url,
        registration_enabled=True,
        allowed_origin="https://testserver",
        market_data_provider="tej",
        tej_auto_sync=False,  # simulate: partitions not yet downloaded
        tej_data_dir=str(tmp_path / "nonexistent_tej_dir"),  # no parquet files
    )

    app = create_app(settings=settings)
    with TestClient(app, base_url="https://testserver") as client:
        # Register + login
        client.post(
            "/auth/register",
            headers={"Origin": "https://testserver"},
            json={"email": "user@example.com", "password": "secret-password-123"},
        )

        # Screen must not return 200 with empty/partial data
        r = client.get("/api/v1/market-data/universe/largecap/screen")
        # Expected: 503 (universe not available / data unavailable) or 422 (expired)
        # NOT 200 — that would mean we're serving unverified results
        assert r.status_code in (422, 503), (
            f"Expected 422 or 503 when TEJ partitions are absent, got {r.status_code}: {r.text}"
        )
