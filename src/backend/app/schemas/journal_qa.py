from typing import Annotated, Literal, TypedDict
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.entries import JournalDate

MAX_QUESTION_CHARS = 1000
MAX_QA_SOURCES = 5
MAX_EXCERPT_CHARS = 1200
MAX_QA_CONTEXT_CHARS = 8000


class JournalQuestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)

    @field_validator("question")
    @classmethod
    def plain_question(cls, value):
        if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
            raise ValueError("Question contains unsupported control characters.")
        return value


class JournalQASource(TypedDict):
    id: str
    journal_date: str
    content: str


class JournalExcerpt(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: UUID
    journal_date: JournalDate
    content: str = Field(min_length=1, max_length=MAX_EXCERPT_CHARS)


class JournalAnswerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, revalidate_instances="always")
    status: Literal["answered", "insufficient_evidence"]
    answer: str = Field(min_length=1, max_length=2400)
    source_dates: Annotated[list[JournalDate], Field(max_length=MAX_QA_SOURCES),
                            AfterValidator(lambda days: sorted(set(days)))]

    @model_validator(mode="after")
    def evidence_matches_status(self):
        if self.status == "answered" and not self.source_dates:
            raise ValueError("An answer requires supporting dates.")
        if self.status == "insufficient_evidence" and self.source_dates:
            raise ValueError("Insufficient evidence cannot assert supporting dates.")
        return self
