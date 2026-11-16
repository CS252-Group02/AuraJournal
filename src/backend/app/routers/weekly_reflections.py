import json
from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import User
from app.schemas.weekly import WeeklyReflectionContent, WeeklyReflectionRequest, WeeklyReflectionResponse
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.journal_history import entries_in_range
from app.services.weekly_reflection import (
    MAX_WEEKLY_REFLECTION_INPUT,
    WeeklyReflectionGenerator,
    WeeklyReflectionSource,
    WeeklyReflectionTooLarge,
)

router = APIRouter(prefix="/api/weekly-reflections", tags=["weekly reflections"])


def get_weekly_reflection_generator(request: Request) -> WeeklyReflectionGenerator | None:
    return request.app.state.weekly_reflection_generator


def _source_snapshot(session: Session, user_id: UUID, start: date, end: date):
    return [(entry.id, entry.journal_date, entry.content, entry.created_at, entry.updated_at)
            for entry in reversed(entries_in_range(session, user_id, start, end))]


@router.post("", response_model=WeeklyReflectionResponse)
def generate_weekly_reflection(
    payload: WeeklyReflectionRequest,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
    generator: WeeklyReflectionGenerator | None = Depends(get_weekly_reflection_generator),
) -> WeeklyReflectionResponse:
    start, end = payload.period_start, payload.period_start + timedelta(days=6)
    user_id = user.id
    snapshot = _source_snapshot(session, user_id, start, end)
    response = dict(period_start=start, period_end=end, entry_count=len(snapshot))
    if not snapshot:
        return WeeklyReflectionResponse(**response, summary=None, questions=[])

    sources: list[WeeklyReflectionSource] = [
        {"id": str(entry_id), "journal_date": day.isoformat(), "content": content}
        for entry_id, day, content, _, _ in snapshot
    ]
    # Release the read transaction while the provider processes this immutable snapshot.
    session.rollback()
    try:
        if len(json.dumps({"entries": sources}, ensure_ascii=False)) > MAX_WEEKLY_REFLECTION_INPUT:
            raise WeeklyReflectionTooLarge
        if generator is None:
            raise AIServiceNotConfiguredError
        result = WeeklyReflectionContent.model_validate(generator.generate(sources))
    except WeeklyReflectionTooLarge:
        raise HTTPException(413, "This period's entries are too long. No entries were omitted.") from None
    except (AIInvalidResponseError, ValidationError):
        raise HTTPException(502, "AI service returned an invalid weekly reflection.") from None
    except (AIServiceNotConfiguredError, AIServiceUnavailableError):
        raise HTTPException(503, "AI weekly reflection service is unavailable. Please try again later.") from None

    if snapshot != _source_snapshot(session, user_id, start, end):
        raise HTTPException(409, "Your journals changed during generation. Generate the reflection again.")
    return WeeklyReflectionResponse(**response, summary=result.summary, questions=result.questions)
