from datetime import UTC, datetime, timedelta
import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.dependencies.auth import (
    AuthenticatedSession,
    get_authenticated_session,
    require_csrf,
    require_same_origin,
)
from app.core.security import hash_password, new_opaque_token, token_digest, verify_password
from app.database.session import get_db
from app.models.auth_session import AuthSession
from app.models.user import User
from app.schemas.auth import LoginRequest, RegisterRequest
from app.schemas.portfolio import UserRead

router = APIRouter(prefix="/auth", tags=["authentication"])


def _set_session_cookies(response: Response, request: Request, raw_session: str, raw_csrf: str) -> None:
    settings = request.app.state.settings
    max_age = settings.session_ttl_seconds
    response.set_cookie(
        settings.session_cookie_name,
        raw_session,
        max_age=max_age,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        settings.csrf_cookie_name,
        raw_csrf,
        max_age=max_age,
        httponly=False,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )


def _issue_session(
    db: Session,
    *,
    user: User,
    request: Request,
    response: Response,
) -> None:
    settings = request.app.state.settings
    raw_session = new_opaque_token()
    raw_csrf = new_opaque_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=token_digest(raw_session),
            csrf_token_hash=token_digest(raw_csrf),
            expires_at=datetime.now(UTC) + timedelta(seconds=settings.session_ttl_seconds),
        )
    )
    db.commit()
    _set_session_cookies(response, request, raw_session, raw_csrf)


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> User:
    require_same_origin(request)
    if not request.app.state.settings.registration_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Registration is disabled.")

    user = User(
        email=str(body.email).strip().casefold(),
        display_name=body.display_name,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Unable to register with the supplied details.",
        ) from exc

    _issue_session(db, user=user, request=request, response=response)
    return user


@router.post("/login", response_model=UserRead)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> User:
    require_same_origin(request)
    normalized_email = str(body.email).strip().casefold()
    user = db.scalar(select(User).where(User.email == normalized_email))
    password_is_valid = verify_password(body.password, user.password_hash if user else None)
    if user is None or not password_is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    _issue_session(db, user=user, request=request, response=response)
    return user


@router.get("/me", response_model=UserRead)
def read_current_user(
    authenticated: AuthenticatedSession = Depends(get_authenticated_session),
) -> User:
    return authenticated.user


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    authenticated: AuthenticatedSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> Response:
    db.delete(authenticated.session)
    db.commit()
    settings = request.app.state.settings
    for cookie_name in (settings.session_cookie_name, settings.csrf_cookie_name):
        response.delete_cookie(
            cookie_name,
            path="/",
            secure=settings.session_cookie_secure,
            httponly=cookie_name == settings.session_cookie_name,
            samesite="lax",
        )
    return {"status": "logged_out"}