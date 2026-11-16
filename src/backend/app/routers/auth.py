from datetime import timedelta
from math import ceil

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select, text, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (COOKIE_NAME, DUMMY_HASH, cookie_secure, current_user, digest,
                      issue_session, password_hasher, utcnow, verify_password)
from app.database import get_session
from app.models import AuthSession, LoginAttempt, User
from app.schemas.auth import Credentials, RegistrationCredentials, UserResponse
from app.limits import client_ip, registration_budget, login_budget

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201,
             dependencies=[Depends(registration_budget)])
def register(payload: RegistrationCredentials, request: Request, response: Response,
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


@router.post("/login", response_model=UserResponse, dependencies=[Depends(login_budget)])
def login(payload: Credentials, request: Request, response: Response,
          session: Session = Depends(get_session)):
    ip = client_ip(request)
    # Serialize attempts for the same identity across processes and workers.
    for key in sorted(["login:email:" + payload.email, "login:ip:" + ip]):
        session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key})
    now = utcnow()
    cutoff = now - timedelta(minutes=15)
    session.execute(delete(LoginAttempt).where(LoginAttempt.created_at <= cutoff))
    attempts = session.scalars(select(LoginAttempt).where(
        or_(LoginAttempt.email == payload.email, LoginAttempt.ip == ip),
    ).order_by(LoginAttempt.created_at)).all()
    account_attempts = [a for a in attempts if a.email == payload.email]
    ip_attempts = [a for a in attempts if a.ip == ip]
    blocked = [group for group, maximum in [(account_attempts, 5), (ip_attempts, 30)]
               if len(group) >= maximum]
    if blocked:
        retry = max(1, max(ceil((group[0].created_at + timedelta(minutes=15) - now).total_seconds())
                           for group in blocked))
        session.commit()
        raise HTTPException(429, "Too many login attempts. Try again later.", headers={"Retry-After": str(retry)})
    user = session.scalar(select(User).where(User.email == payload.email))
    valid = verify_password(payload.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        session.add(LoginAttempt(email=payload.email, ip=ip))
        session.commit()
        raise HTTPException(401, "Invalid email or password.")
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(payload.password)
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
