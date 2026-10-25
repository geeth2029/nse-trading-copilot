from dataclasses import dataclass
from datetime import UTC, datetime
import hmac
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from app.database.session import get_db
from app.models.auth_session import AuthSession
from app.models.user import User
from app.core.security import token_digest


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    user: User
    session: AuthSession


def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Same-origin request required.")

    received = urlsplit(origin)
    expected = urlsplit(str(request.base_url))
    if received.scheme != expected.scheme or received.netloc.lower() != expected.netloc.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Same-origin request required.")


def get_authenticated_session(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthenticatedSession:
    settings = request.app.state.settings
    raw_token = request.cookies.get(settings.session_cookie_name)
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    auth_session = db.scalar(
        select(AuthSession)
        .where(AuthSession.token_hash == token_digest(raw_token))
        .options(joinedload(AuthSession.user))
    )
    if auth_session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    now = datetime.now(UTC)
    expires_at = auth_session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= now:
        db.execute(delete(AuthSession).where(AuthSession.id == auth_session.id))
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired.")

    return AuthenticatedSession(user=auth_session.user, session=auth_session)


def require_csrf(
    request: Request,
    authenticated: AuthenticatedSession = Depends(get_authenticated_session),
) -> AuthenticatedSession:
    settings = request.app.state.settings
    cookie_token = request.cookies.get(settings.csrf_cookie_name)
    header_token = request.headers.get("x-csrf-token")
    if (
        not cookie_token
        or not header_token
        or not hmac.compare_digest(cookie_token, header_token)
        or not hmac.compare_digest(token_digest(cookie_token), authenticated.session.csrf_token_hash)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF validation failed.")
    return authenticated