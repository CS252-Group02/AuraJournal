from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user, revalidate_session_owner
from app.ai_errors import ai_service_error
from app.limits import ai_budget
from app.database import get_session
from app.models import JournalEntry, User
from app.schemas.ai import JournalSummaryResponse
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalSummarizer,
    JournalSummary,
)
from app.services._groq import validate_journal_text

router = APIRouter(prefix="/api/entries", tags=["AI journal summaries"])


def get_journal_summarizer(request: Request) -> JournalSummarizer:
    return request.app.state.journal_summarizer


@router.post("/{entry_id}/summary", response_model=JournalSummaryResponse,
             dependencies=[Depends(ai_budget)])
def summarize_entry(
    entry_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
    summarizer: JournalSummarizer = Depends(get_journal_summarizer),
) -> JournalSummaryResponse:
    entry = session.scalar(select(JournalEntry).where(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == user.id,
    ))
    if entry is None:
        raise HTTPException(status_code=404, detail="Journal entry was not found.")

    owner_id = user.id
    snapshot = (entry.content, entry.content_version, entry.journal_date, entry.updated_at)
    try:
        content = validate_journal_text(entry.content)
    except (EmptyJournalError, ValidationError):
        raise HTTPException(422, "Journal entry must contain valid text of at most 5000 characters.") from None

    try:
        if summarizer is None:
            raise AIServiceNotConfiguredError
        result = JournalSummary.model_validate(summarizer.summarize(content))
    except EmptyJournalError:
        raise HTTPException(
            status_code=422, detail="Journal entry cannot be empty."
        ) from None
    except (AIInvalidResponseError, ValidationError, AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise ai_service_error(error,
            invalid_detail="AI service returned an invalid response.",
            unavailable_detail="AI summary service is unavailable. Please try again later.",
        ) from None

    revalidate_session_owner(request, session, owner_id)
    entry = session.scalar(select(JournalEntry).where(
        JournalEntry.id == entry_id, JournalEntry.user_id == owner_id,
    ).with_for_update())
    if entry is None or snapshot != (entry.content, entry.content_version, entry.journal_date, entry.updated_at):
        raise HTTPException(409, "Your journal changed during generation. Generate the reflection again.")

    summarized_at = datetime.now(timezone.utc)
    entry.ai_summary = result.summary
    entry.ai_reflection_question = None
    entry.ai_summarized_at = summarized_at
    session.commit()

    return JournalSummaryResponse(
        entry_id=entry.id,
        summary=result.summary,
        summarized_at=summarized_at,
    )
