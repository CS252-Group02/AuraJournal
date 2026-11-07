import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.config import frontend_origin
from app.database import get_session
from app.models import AuthSession, User

COOKIE_NAME = "aurajournal_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
password_hasher = PasswordHasher()
DUMMY_HASH = password_hasher.hash(secrets.token_urlsafe(32))


def utcnow():
    return datetime.now(timezone.utc)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def cookie_secure():
    return os.environ.get("AUTH_COOKIE_SECURE", "false").lower() == "true"


def require_browser_request(request: Request):
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    if request.headers.get("origin") != frontend_origin() or request.headers.get("x-aurajournal-csrf") != "1":
        raise HTTPException(403, "Request origin or CSRF header is invalid.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Use application/json.")


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        # Disabled users take the same expensive verification path as unknown users.
        if stored_hash.startswith("!"):
            password_hasher.verify(DUMMY_HASH, password)
            return False
        return password_hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def current_user(request: Request, session: Session = Depends(get_session)) -> User:
    token = request.cookies.get(COOKIE_NAME, "")
    record = session.get(AuthSession, digest(token)) if token else None
    if record is None or record.expires_at <= utcnow():
        raise HTTPException(401, "Please log in.")
    user = session.get(User, record.user_id)
    if user is None or user.password_hash.startswith("!"):
        raise HTTPException(401, "Please log in.")
    return user


def issue_session(session: Session, request: Request, response: Response, user: User):
    session.execute(delete(AuthSession).where(AuthSession.expires_at <= utcnow()))
    old_token = request.cookies.get(COOKIE_NAME)
    if old_token:
        old = session.get(AuthSession, digest(old_token))
        if old:
            session.delete(old)
    token = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(seconds=SESSION_SECONDS)
    session.add(AuthSession(token_hash=digest(token), user_id=user.id, expires_at=expires))
    session.commit()
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, expires=expires,
                        httponly=True, secure=cookie_secure(), samesite="lax", path="/api")
    response.headers["Cache-Control"] = "no-store"
