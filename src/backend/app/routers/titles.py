from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth import current_user
from app.schemas.ai import JournalTitleRequest, JournalTitleResponse
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalTitleGenerator,
)

router = APIRouter(
    prefix="/api/ai", tags=["AI journal titles"], dependencies=[Depends(current_user)]
)


def get_journal_title_generator(request: Request) -> JournalTitleGenerator:
    return request.app.state.journal_title_generator


@router.post("/suggest-title", response_model=JournalTitleResponse)
def suggest_title(
    payload: JournalTitleRequest,
    generator: JournalTitleGenerator = Depends(get_journal_title_generator),
) -> JournalTitleResponse:
    try:
        result = generator.generate(payload.content)
    except EmptyJournalError as error:
        raise HTTPException(
            status_code=422, detail="Journal content cannot be empty."
        ) from error
    except AIInvalidResponseError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI service returned an invalid response.",
        ) from error
    except (AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI title service is unavailable. Please try again later.",
        ) from error

    return JournalTitleResponse(suggested_title=result.suggested_title)
