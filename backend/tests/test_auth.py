from datetime import UTC, datetime, timedelta
from http.cookies import SimpleCookie

from sqlalchemy import select

from app.core.security import token_digest
from app.models.auth_session import AuthSession
from app.models.user import User


def register_user(client, *, email="owner@example.com", password="correct horse battery staple"):
    return client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": email, "password": password, "displayName": "Test Owner"},
    )


def cookie_value(client, cookie_name: str) -> str:
    return client.cookies.get(cookie_name)


def test_registration_hashes_password_and_sets_secure_server_session(client):
    response = register_user(client)

    assert response.status_code == 201
    assert "password" not in response.json()
    assert "password_hash" not in response.json()

    user = client.app.state.session_factory().scalar(
        select(User).where(User.email == "owner@example.com")
    )
    assert user is not None
    assert user.password_hash != "correct horse battery staple"
    assert user.password_hash.startswith("$argon2")

    session_cookie = next(
        cookie for cookie in response.headers.get_list("set-cookie") if cookie.startswith("nse_session=")
    )
    parsed = SimpleCookie()
    parsed.load(session_cookie)
    morsel = parsed["nse_session"]
    assert morsel["httponly"]
    assert morsel["secure"]
    assert morsel["samesite"].lower() == "lax"

    raw_token = cookie_value(client, "nse_session")
    db = client.app.state.session_factory()
    try:
        stored = db.scalar(select(AuthSession).where(AuthSession.user_id == user.id))
        assert stored is not None
        assert stored.token_hash == token_digest(raw_token)
        assert stored.token_hash != raw_token
        expires_at = stored.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        assert expires_at > datetime.now(UTC)
    finally:
        db.close()


def test_registration_is_disabled_by_default(tmp_path):
    from app.core.config import Settings
    from app.main import create_app
    from fastapi.testclient import TestClient

    database_url = f"sqlite:///{(tmp_path / 'registration-disabled.db').as_posix()}"
    from tests.conftest import upgrade_database

    upgrade_database(database_url)
    app = create_app(Settings(database_url=database_url))
    with TestClient(app, base_url="https://testserver") as client:
        response = register_user(client)
    assert response.status_code == 403


def test_login_and_current_user_ignore_supplied_identity(client):
    assert register_user(client).status_code == 201
    client.post("/auth/logout", headers={"x-csrf-token": cookie_value(client, "nse_csrf")})

    response = client.post(
        "/auth/login",
        headers={"Origin": "https://testserver"},
        json={"email": "owner@example.com", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200

    me = client.get("/auth/me", params={"user_id": "someone-else"})
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"

    forged = client.get("/auth/me", headers={"x-user-id": "someone-else"})
    assert forged.status_code == 200
    assert forged.json()["email"] == "owner@example.com"


def test_incorrect_and_unknown_account_use_same_login_error(client):
    assert register_user(client).status_code == 201
    client.post("/auth/logout", headers={"x-csrf-token": cookie_value(client, "nse_csrf")})

    wrong_password = client.post(
        "/auth/login",
        headers={"Origin": "https://testserver"},
        json={"email": "owner@example.com", "password": "incorrect password"},
    )
    unknown_account = client.post(
        "/auth/login",
        headers={"Origin": "https://testserver"},
        json={"email": "nobody@example.com", "password": "incorrect password"},
    )

    assert wrong_password.status_code == unknown_account.status_code == 401
    assert wrong_password.json() == unknown_account.json()


def test_logout_requires_csrf_and_revokes_session(client):
    assert register_user(client).status_code == 201
    raw_session = cookie_value(client, "nse_session")

    denied = client.post("/auth/logout")
    assert denied.status_code == 403
    assert client.get("/auth/me").status_code == 200

    csrf = cookie_value(client, "nse_csrf")
    response = client.post("/auth/logout", headers={"x-csrf-token": csrf})
    assert response.status_code == 200
    assert response.json() == {"status": "logged_out"}
    assert client.get("/auth/me").status_code == 401

    db = client.app.state.session_factory()
    try:
        assert db.scalar(select(AuthSession).where(AuthSession.token_hash == token_digest(raw_session))) is None
    finally:
        db.close()


def test_expired_session_is_rejected_and_removed(client):
    assert register_user(client).status_code == 201
    raw_session = cookie_value(client, "nse_session")
    digest = token_digest(raw_session)
    db = client.app.state.session_factory()
    try:
        auth_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == digest))
        auth_session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()

    response = client.get("/auth/me")
    assert response.status_code == 401
    assert response.json()["detail"] == "Session expired."

    db = client.app.state.session_factory()
    try:
        assert db.scalar(select(AuthSession).where(AuthSession.token_hash == digest)) is None
    finally:
        db.close()


def test_auth_rejects_cross_origin_state_change(client):
    response = client.post(
        "/auth/register",
        headers={"Origin": "https://attacker.example"},
        json={"email": "owner@example.com", "password": "correct horse battery staple"},
    )
    assert response.status_code == 403