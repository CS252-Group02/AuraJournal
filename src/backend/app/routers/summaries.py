from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import JournalEntry, User
from app.schemas.ai import JournalSummaryResponse
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalSummarizer,
)

router = APIRouter(prefix="/api/entries", tags=["AI journal summaries"])


def get_journal_summarizer(request: Request) -> JournalSummarizer:
    return request.app.state.journal_summarizer


@router.post("/{entry_id}/summary", response_model=JournalSummaryResponse)
def summarize_entry(
    entry_id: UUID,
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

    try:
        result = summarizer.summarize(entry.content)
    except EmptyJournalError as error:
        raise HTTPException(
            status_code=422, detail="Journal entry cannot be empty."
        ) from error
    except AIInvalidResponseError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI service returned an invalid response.",
        ) from error
    except (AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI summary service is unavailable. Please try again later.",
        ) from error

    summarized_at = datetime.now(timezone.utc)
    entry.ai_summary = result.summary
    entry.ai_reflection_question = result.reflection_question
    entry.ai_summarized_at = summarized_at
    session.commit()

    return JournalSummaryResponse(
        entry_id=entry.id,
        summary=result.summary,
        reflection_question=result.reflection_question,
        summarized_at=summarized_at,
    )
