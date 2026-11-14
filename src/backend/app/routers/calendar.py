"""Authenticated calendar and dashboard APIs."""
import calendar
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import User
from app.services.journal_history import current_streak, daily_entry_counts

router = APIRouter(prefix="/api", tags=["calendar"])
ZONE = "Asia/Bangkok"


def today() -> date:
    return datetime.now(ZoneInfo(ZONE)).date()


class DayCount(BaseModel):
    date: date
    count: int


class CalendarResponse(BaseModel):
    year: int
    month: int
    days: list[DayCount]


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


