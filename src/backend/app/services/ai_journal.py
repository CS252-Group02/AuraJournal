from typing import Protocol

from groq import Groq
from pydantic import BaseModel, Field

from app.config import groq_api_key, groq_model


SYSTEM_PROMPT = """You summarize private journal entries.

Return one JSON object with exactly these fields:
- "summary": a concise, factual summary of one to three sentences
- "reflection_question": one gentle question grounded in the journal entry

Write in the same language as the journal entry. Use only information present in
the entry. Do not invent people, places, events, emotions, or diagnoses. Do not
include Markdown or any text outside the JSON object.
"""


class JournalSummary(BaseModel):
    summary: str = Field(min_length=1, max_length=500)
    reflection_question: str = Field(min_length=1, max_length=300)


class GroqChatClient(Protocol):
    @property
    def chat(self): ...


class JournalSummarizer:
    """Generate structured journal assistance through a reusable Groq client."""

    def __init__(
        self,
        client: GroqChatClient | None = None,
        model: str | None = None,
    ) -> None:
        self._client = client or Groq(api_key=groq_api_key())
        self._model = model or groq_model()

    def summarize(self, text: str) -> JournalSummary:
        completion = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_completion_tokens=300,
        )
        content = completion.choices[0].message.content
        return JournalSummary.model_validate_json(content)
