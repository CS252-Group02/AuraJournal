"""Authenticated calendar and dashboard APIs."""
import calendar
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import User
from app.services.journal_history import current_streak, daily_entry_counts

router = APIRouter(prefix="/api", tags=["calendar"])
ZONE = "Asia/Bangkok"


def calendar_timezone(timezone: Annotated[str, Query(min_length=1, max_length=100)] = ZONE) -> str:
    """Use the caller's IANA timezone without changing stored journal dates."""
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Choose a valid IANA timezone.") from None
    return timezone


def utc_now() -> datetime:
    return datetime.now(datetime_timezone.utc)


def today(zone: str = Depends(calendar_timezone), now: datetime = Depends(utc_now)) -> date:
    return now.astimezone(ZoneInfo(zone)).date()


class DayCount(BaseModel):
    date: date
    count: int


class CalendarResponse(BaseModel):
    year: int
    month: int
    days: list[DayCount]


class StreakResponse(BaseModel):
    as_of: date
    timezone: str
    current_streak: int


class DashboardResponse(StreakResponse):
    year: int
    month: int
    entry_count: int
    active_days: int


def month_counts(session, owner, year, month):
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    return start, end, daily_entry_counts(session, owner, start, end)


@router.get("/calendar", response_model=CalendarResponse)
def monthly_calendar(year: int = Query(ge=1, le=9999), month: int = Query(ge=1, le=12),
                     session: Session = Depends(get_session), user: User = Depends(current_user)):
    start, end, counts = month_counts(session, user.id, year, month)
    return dict(year=year, month=month, days=[
        dict(date=start + timedelta(days=offset), count=counts.get(start + timedelta(days=offset), 0))
        for offset in range((end - start).days + 1)
    ])


@router.get("/stats/streak", response_model=StreakResponse)
def streak(session: Session = Depends(get_session), user: User = Depends(current_user),
           zone: str = Depends(calendar_timezone), as_of: date = Depends(today)):
    return dict(as_of=as_of, timezone=zone, current_streak=current_streak(session, user.id, as_of))


@router.get("/dashboard", response_model=DashboardResponse)
def dashboard(year: int = Query(ge=1, le=9999), month: int = Query(ge=1, le=12),
              session: Session = Depends(get_session), user: User = Depends(current_user),
              zone: str = Depends(calendar_timezone), as_of: date = Depends(today)):
    _, _, counts = month_counts(session, user.id, year, month)
    return dict(year=year, month=month, entry_count=sum(counts.values()), active_days=len(counts),
                as_of=as_of, timezone=zone, current_streak=current_streak(session, user.id, as_of))
