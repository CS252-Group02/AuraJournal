from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class JournalSummaryResponse(BaseModel):
    entry_id: UUID
    summary: str
    reflection_question: str
    summarized_at: datetime
