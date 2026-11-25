"""Public HTTP mapping for the existing typed AI adapter failures.

Provider exception messages may contain credentials or user input. Never stringify
or log them here. Audio retains its distinct codec/deadline/rate-limit contract.
"""
from fastapi import HTTPException
from pydantic import ValidationError

from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError


def ai_service_error(error, *, invalid_detail: str, unavailable_detail: str) -> HTTPException:
    if isinstance(error, (AIInvalidResponseError, ValidationError)):
        return HTTPException(502, invalid_detail)
    if isinstance(error, (AIServiceNotConfiguredError, AIServiceUnavailableError)):
        return HTTPException(503, unavailable_detail)
    raise TypeError("Only typed AI adapter errors can be mapped.")
