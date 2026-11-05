from datetime import timedelta
from math import ceil

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (COOKIE_NAME, DUMMY_HASH, cookie_secure, current_user, digest,
                      issue_session, password_hasher, utcnow, verify_password)
from app.database import get_session
from app.models import AuthSession, LoginAttempt, User
from app.schemas.auth import Credentials, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201)
def register(payload: Credentials, request: Request, response: Response,
             session: Session = Depends(get_session)):
    user = User(email=payload.email, password_hash=password_hasher.hash(payload.password))
    session.add(user)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "An account with that email already exists.") from None
    issue_session(session, request, response, user)
    return user


@router.post("/login", response_model=UserResponse)
def login(payload: Credentials, request: Request, response: Response,
          session: Session = Depends(get_session)):
    ip = request.client.host if request.client else "unknown"
    # Serialize attempts for the same identity across processes and workers.
    session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": payload.email + "|" + ip})
    now = utcnow()
    cutoff = now - timedelta(minutes=15)
    session.execute(delete(LoginAttempt).where(LoginAttempt.created_at <= cutoff))
    attempts = session.scalars(select(LoginAttempt).where(
        LoginAttempt.email == payload.email, LoginAttempt.ip == ip,
    ).order_by(LoginAttempt.created_at)).all()
    if len(attempts) >= 5:
        retry = max(1, ceil((attempts[0].created_at + timedelta(minutes=15) - now).total_seconds()))
        session.commit()
        raise HTTPException(429, "Too many login attempts. Try again later.", headers={"Retry-After": str(retry)})
    user = session.scalar(select(User).where(User.email == payload.email))
    valid = verify_password(payload.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        session.add(LoginAttempt(email=payload.email, ip=ip))
        session.commit()
        raise HTTPException(401, "Invalid email or password.")
    session.execute(delete(LoginAttempt).where(LoginAttempt.email == payload.email, LoginAttempt.ip == ip))
    issue_session(session, request, response, user)
    return user


@router.get("/me", response_model=UserResponse)
def me(response: Response, user: User = Depends(current_user)):
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, session: Session = Depends(get_session)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        session.execute(delete(AuthSession).where(AuthSession.token_hash == digest(token)))
        session.commit()
    response.delete_cookie(COOKIE_NAME, path="/api", httponly=True,
                           secure=cookie_secure(), samesite="lax")
    response.headers["Cache-Control"] = "no-store"
