import json
import re
from tempfile import TemporaryFile
from typing import BinaryIO
from uuid import UUID

from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JournalEntry


def entry_title(content: str) -> str:
    # Match the journal display title derived by the frontend.
    text = content.strip()
    if not text:
        return "Untitled entry"
    line = text.split("\n", 1)[0].strip()
    sentence = re.match(r"^[^\r\u2028\u2029]+?[.!?…](?=\s|$)", line)
    title = (sentence[0] if sentence else line).rstrip(".")
    if len(title) <= 60:
        return title
    cut = title[:60]
    space = cut.rfind(" ")
    if space > 36:
        cut = cut[:space]
    return re.sub(r"[\s,;:.–—-]+$", "", cut) + "…"


class JournalExportResponse(StreamingResponse):
    def __init__(self, archive: BinaryIO):
        self.archive = archive
        chunks = iter(lambda: archive.read(64 * 1024), b"")
        super().__init__(chunks, media_type="application/json", headers={
            "Content-Disposition": 'attachment; filename="aurajournal-export.json"',
            "Cache-Control": "no-store",
        })

    async def __call__(self, scope, receive, send):
        with self.archive:
            await super().__call__(scope, receive, send)


def export_journal(session: Session, user_id: UUID) -> JournalExportResponse:
    query = (select(JournalEntry.journal_date, JournalEntry.content)
             .where(JournalEntry.user_id == user_id)
             .order_by(JournalEntry.journal_date, JournalEntry.created_at, JournalEntry.id)
             .execution_options(yield_per=256))
    archive = TemporaryFile(mode="w+b")
    try:
        archive.write(b"[")
        with session.execute(query) as entries:
            for index, (day, content) in enumerate(entries):
                if index:
                    archive.write(b",")
                archive.write(json.dumps({
                    "journal_date": day.isoformat(), "title": entry_title(content), "content": content,
                }, ensure_ascii=False).encode("utf-8"))
        archive.write(b"]")
        archive.seek(0)
        session.rollback()  # Release the connection before the client begins downloading.
        return JournalExportResponse(archive)
    except BaseException:
        archive.close()
        raise
