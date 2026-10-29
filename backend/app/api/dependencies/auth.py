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


def _origin_tuple(parsed) -> tuple[str, str, int | None]:
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    port = parsed.port
    if (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
        port = None
    return (scheme, host, port)


def require_same_origin(request: Request) -> None:
    """Accept requests whose Origin or Referer matches either the backend's own base_url
    (local / direct same-origin) or the single configured allowed_origin
    (Vercel proxy — browser origin is the frontend domain).

    Standard browsers (e.g. Safari / WebKit) omit the Origin header on same-origin
    POST requests, sending only the Referer header. Following OWASP CSRF prevention
    guidelines:
    1. If Origin is present (and not 'null'), validate it. If it fails, reject immediately.
    2. If Origin is absent, inspect Referer and validate its origin.
    3. If both are absent or neither matches, reject with 403.

    All other origins are rejected with 403. We never trust arbitrary
    forwarded headers and never accept wildcard origins with credentials.
    """
    settings = request.app.state.settings
    allowed = urlsplit(settings.allowed_origin.strip())
    expected_backend = urlsplit(str(request.base_url))

    expected_origins = {_origin_tuple(expected_backend)}
    if allowed.scheme and allowed.hostname:
        expected_origins.add(_origin_tuple(allowed))

    def _matches(candidate_url: str) -> bool:
        parsed = urlsplit(candidate_url)
        cand = _origin_tuple(parsed)
        if not cand[0] or not cand[1]:
            return False
        return cand in expected_origins

    origin = request.headers.get("origin")
    if origin is not None and origin.strip():
        origin_val = origin.strip()
        if origin_val.lower() != "null" and _matches(origin_val):
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Same-origin request required.",
        )

    referer = request.headers.get("referer")
    if referer and referer.strip() and _matches(referer.strip()):
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Same-origin request required.",
    )


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