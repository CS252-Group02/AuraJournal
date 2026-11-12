from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import JournalEntry, User
from app.schemas.weekly import WeeklyRecapRequest, WeeklyRecapResponse
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.weekly_recap import WeeklyRecapGenerator, WeeklyRecapTooLarge

router = APIRouter(prefix="/api/reflections", tags=["weekly recaps"])


def week_bounds(start, zone):
    local_start = datetime.combine(start, time.min, ZoneInfo(zone))
    local_end = datetime.combine(start + timedelta(days=7), time.min, ZoneInfo(zone))
    return local_start.astimezone(timezone.utc), local_end.astimezone(timezone.utc)


def get_weekly_generator(request: Request) -> WeeklyRecapGenerator:
    return request.app.state.weekly_recap_generator


@router.post("/weekly", response_model=WeeklyRecapResponse)
def weekly_recap(payload: WeeklyRecapRequest, session: Session = Depends(get_session),
                 user: User = Depends(current_user), generator: WeeklyRecapGenerator = Depends(get_weekly_generator)):
    start, end = week_bounds(payload.start, payload.timezone)
    user_id = user.id
    query = select(JournalEntry.id, JournalEntry.content, JournalEntry.created_at, JournalEntry.updated_at).where(
        JournalEntry.user_id == user_id, JournalEntry.created_at >= start, JournalEntry.created_at < end,
    ).order_by(JournalEntry.created_at, JournalEntry.id)
    rows = session.execute(query).all()
    response = dict(week_start=payload.start, week_end=payload.start + timedelta(days=6),
                    timezone=payload.timezone, entry_count=len(rows))
    if not rows:
        return WeeklyRecapResponse(**response, summary=None, highlights=[])
    sources = [{"id": str(row.id), "recorded_at": row.created_at.astimezone(ZoneInfo(payload.timezone)).isoformat(),
                "content": row.content} for row in rows]
    # Release the read transaction/connection while waiting for the provider.
    session.rollback()
    try:
        result = generator.generate(sources)
    except WeeklyRecapTooLarge:
        raise HTTPException(413, "This week's entries are too long for one recap. No entries were omitted.") from None
    except AIInvalidResponseError:
        raise HTTPException(502, "AI service returned an invalid recap.") from None
    except (AIServiceNotConfiguredError, AIServiceUnavailableError):
        raise HTTPException(503, "AI recap service is unavailable. Please try again later.") from None
    if rows != session.execute(query).all():
        raise HTTPException(409, "Your journals changed during generation. Generate the recap again.")
    return WeeklyRecapResponse(**response, summary=result.summary, highlights=result.highlights)
