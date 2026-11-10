"""PostgreSQL budgets shared across workers. Never trust headers for identity here."""
import hashlib
from datetime import timedelta
from math import ceil

from fastapi import Depends, HTTPException, Request
from sqlalchemy import case, delete, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth import current_user, utcnow
from app.database import get_session
from app.models import RateLimitBucket, User


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def consume(session: Session, budgets: list[tuple[str, int, int]]) -> None:
    """Each (key, maximum, seconds) counts attempts, including rejected requests.

    Commit before expensive work so failure/rollback cannot refund the budget.
    Sorted keys avoid lock-order deadlocks between overlapping budgets.
    """
    now = utcnow()
    retry = 0
    session.execute(delete(RateLimitBucket).where(RateLimitBucket.expires_at <= now))
    for key, maximum, seconds in sorted(budgets):
        hashed = hashlib.sha256(key.encode()).hexdigest()
        table = RateLimitBucket
        expired = table.expires_at <= now
        row = session.execute(insert(table).values(
            key=hashed, attempts=1, expires_at=now + timedelta(seconds=seconds),
        ).on_conflict_do_update(index_elements=[table.key], set_={
            "attempts": case((expired, 1), else_=table.attempts + 1),
            "expires_at": case((expired, now + timedelta(seconds=seconds)), else_=table.expires_at),
        }).returning(table.attempts, table.expires_at)).one()
        if row.attempts > maximum:
            retry = max(retry, ceil((row.expires_at - now).total_seconds()))
    session.commit()
    if retry:
        raise HTTPException(429, "Too many requests. Try again later.",
                            headers={"Retry-After": str(max(1, retry))})


def registration_budget(request: Request, session: Session = Depends(get_session)):
    consume(session, [("register:ip:" + client_ip(request), 5, 900)])


def login_budget(request: Request, session: Session = Depends(get_session)):
    # Also bound valid-password attempts: failed-login counters alone do not.
    consume(session, [("login:requests:ip:" + client_ip(request), 60, 60)])


def ai_budget(request: Request, user: User = Depends(current_user),
              session: Session = Depends(get_session)):
    consume(session, [
        (f"ai:user:minute:{user.id}", 10, 60),
        (f"ai:user:day:{user.id}", 100, 86400),
        ("ai:ip:" + client_ip(request), 30, 60),
    ])
    # Transaction lock is released when the request-scoped session closes or
    # commits. Another worker must reject, not wait while holding a DB connection.
    locked = session.scalar(text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
                            {"key": f"ai:active:{user.id}"})
    if not locked:
        raise HTTPException(429, "An AI request is already running. Try again shortly.",
                            headers={"Retry-After": "5"})
