"""Authenticated, stateless Q&A over the caller's own dated journal excerpts."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.auth import current_user, revalidate_session_owner
from app.ai_errors import ai_service_error
from app.database import get_session
from app.limits import consume_ai_budget
from app.models import User
from app.schemas.journal_qa import JournalAnswerResponse, JournalQuestionRequest
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.journal_qa import (
    JournalQuestionAnswerer, JournalQuestionTooLarge, insufficient_answer, validate_answer_sources,
)
from app.services.journal_retrieval import retrieve_journals, sources_unchanged

router = APIRouter(prefix="/api/entries", tags=["journal questions"])


def get_question_answerer(request: Request) -> JournalQuestionAnswerer:
    return request.app.state.journal_question_answerer


@router.post("/ask", response_model=JournalAnswerResponse)
def ask_journals(payload: JournalQuestionRequest, request: Request,
                 session: Session = Depends(get_session), user: User = Depends(current_user),
                 answerer: JournalQuestionAnswerer = Depends(get_question_answerer)):
    owner = user.id
    context = retrieve_journals(session, owner, payload.question)
    if not context.sources:
        return insufficient_answer(payload.question)
    consume_ai_budget(request, user, session)
    session.rollback()  # Release the connection before a provider call.
    try:
        if answerer is None:
            raise AIServiceNotConfiguredError
        result = JournalAnswerResponse.model_validate(answerer.answer(
            payload.question, [dict(source) for source in context.sources],
        ))
        validate_answer_sources(result, context.sources)
    except JournalQuestionTooLarge:
        raise HTTPException(413, "Selected journal context is too large for one question.") from None
    except (AIInvalidResponseError, ValidationError, AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise ai_service_error(error,
            invalid_detail="AI service returned an invalid journal answer.",
            unavailable_detail="AI question answering is unavailable. Please try again later.",
        ) from None
    # Re-read session/user state: the provider call can outlive logout or an edit.
    revalidate_session_owner(request, session, owner)
    if not sources_unchanged(session, owner, context):
        raise HTTPException(409, "Your journals changed while answering. Ask again with current entries.")
    return insufficient_answer(payload.question) if result.status == "insufficient_evidence" else result
