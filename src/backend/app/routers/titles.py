from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from app.ai_errors import ai_service_error
from app.limits import ai_budget
from app.schemas.ai import JournalTitleRequest, JournalTitleResponse
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalTitleGenerator,
    JournalTitle,
)

router = APIRouter(
    prefix="/api/ai", tags=["AI journal titles"], dependencies=[Depends(ai_budget)]
)


def get_journal_title_generator(request: Request) -> JournalTitleGenerator:
    return request.app.state.journal_title_generator


@router.post("/suggest-title", response_model=JournalTitleResponse)
def suggest_title(
    payload: JournalTitleRequest,
    generator: JournalTitleGenerator = Depends(get_journal_title_generator),
) -> JournalTitleResponse:
    try:
        if generator is None:
            raise AIServiceNotConfiguredError
        result = JournalTitle.model_validate(generator.generate(payload.content))
    except EmptyJournalError:
        raise HTTPException(
            status_code=422, detail="Journal content cannot be empty."
        ) from None
    except (AIInvalidResponseError, ValidationError, AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise ai_service_error(error,
            invalid_detail="AI service returned an invalid response.",
            unavailable_detail="AI title service is unavailable. Please try again later.",
        ) from None

    return JournalTitleResponse(suggested_title=result.suggested_title)
