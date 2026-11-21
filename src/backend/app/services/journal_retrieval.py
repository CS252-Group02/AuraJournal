"""Local, bounded, owner-scoped lexical retrieval. No external service calls."""
from dataclasses import dataclass
from datetime import date
import json
import re
import unicodedata
from uuid import UUID

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models import JournalEntry
from app.schemas.journal_qa import (
    JournalQASource, MAX_EXCERPT_CHARS, MAX_QA_CONTEXT_CHARS, MAX_QA_SOURCES,
)

STOP_WORDS = set("""a an the i me my myself we our you your it its this that these
those is are was were be been am do does did have has had can could would should
will shall what when where why how which who whom about of on in at to for from
with and or but as by tell please journal journals entry entries happen happened
remember recorded toi minh ban cua chung ta va hay la co khong da dang se duoc bi
thi ma ve voi cho tu tai o trong tren den mot nhung cac nay do gi nao dau khi hom
qua nhat ky xin hay ke lai biet the nao lam toi cung nhieu rat
""".split())
DATE_PATTERN = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
WORD_PATTERN = re.compile(r"[^\W_]+", re.UNICODE)


def fold_text(text: str) -> str:
    text = text.replace("\u0111", "d").replace("\u0110", "D")
    return "".join(char for char in unicodedata.normalize("NFD", text)
                   if unicodedata.category(char) != "Mn").lower()


def _translation_table():
    source, target = [], []
    for codepoint in [*range(0x00C0, 0x0180), *range(0x1E00, 0x1F00)]:
        char = chr(codepoint)
        folded = fold_text(char)
        if len(folded) == 1 and folded.isascii() and folded.isalpha() and folded != char:
            source.append(char)
            target.append(folded)
    source.extend(chr(codepoint) for codepoint in range(0x0300, 0x0370))
    return "".join(source), "".join(target)


FOLD_FROM, FOLD_TO = _translation_table()


@dataclass(frozen=True, repr=False)
class RetrievedJournals:
    sources: list[JournalQASource]
    snapshot: tuple


def _excerpt(content: str, terms: list[str], maximum: int) -> str:
    folded, positions = [], []
    for position, char in enumerate(content):
        for normalized in fold_text(char):
            folded.append(normalized)
            positions.append(position)
    match = next((match for match in WORD_PATTERN.finditer("".join(folded))
                  if match.group() in terms), None)
    anchor = positions[match.start()] if match else len(content) - len(content.lstrip())
    anchor_end = positions[match.end() - 1] + 1 if match else anchor
    while anchor_end < len(content) and unicodedata.category(content[anchor_end]) == "Mn":
        anchor_end += 1
    if anchor_end - anchor > maximum:
        return ""
    padding = min(maximum // 3, maximum - (anchor_end - anchor))
    start = min(max(0, anchor - padding), max(0, len(content) - maximum))
    return content[start:start + maximum].strip()


def retrieve_journals(session: Session, user_id: UUID, question: str) -> RetrievedJournals:
    date_strings = list(dict.fromkeys(DATE_PATTERN.findall(question)))
    try:
        dates = [date.fromisoformat(value) for value in date_strings]
    except ValueError:
        return RetrievedJournals([], ())
    terms = list(dict.fromkeys(word for word in WORD_PATTERN.findall(fold_text(DATE_PATTERN.sub(" ", question)))
                               if len(word) > 1 and word not in STOP_WORDS))[:12]
    if not terms and not dates:
        return RetrievedJournals([], ())
    folded = func.lower(func.translate(JournalEntry.content, FOLD_FROM, FOLD_TO))
    conditions = [folded.op("~")(r"(^|[^[:alnum:]])" + re.escape(term) + r"([^[:alnum:]]|$)") for term in terms]
    ordering = [JournalEntry.journal_date.desc(), JournalEntry.created_at.desc(), JournalEntry.id.desc()]
    if conditions:
        ordering.insert(0, sum(case((condition, 1), else_=0) for condition in conditions).desc())
    query = select(JournalEntry.id, JournalEntry.journal_date, JournalEntry.content).where(JournalEntry.user_id == user_id)
    if dates:
        query = query.where(JournalEntry.journal_date.in_(dates))
    else:
        query = query.where(or_(*conditions))
    rows = session.execute(query.order_by(*ordering).limit(MAX_QA_SOURCES)).all()
    sources, snapshot = [], []
    for row in rows:
        maximum = MAX_EXCERPT_CHARS
        while maximum:
            content = _excerpt(row.content, terms, maximum)
            if not content:
                break
            source = {"id": str(row.id), "journal_date": row.journal_date.isoformat(), "content": content}
            size = len(json.dumps({"question": question, "entries": [*sources, source]}, ensure_ascii=False))
            if size <= MAX_QA_CONTEXT_CHARS:
                sources.append(source)
                snapshot.append((row.id, row.journal_date, row.content))
                break
            maximum //= 2
    return RetrievedJournals(sources, tuple(snapshot))


def sources_unchanged(session: Session, user_id: UUID, context: RetrievedJournals) -> bool:
    ids = [row[0] for row in context.snapshot]
    if not ids:
        return True
    rows = session.execute(select(JournalEntry.id, JournalEntry.journal_date, JournalEntry.content).where(
        JournalEntry.user_id == user_id, JournalEntry.id.in_(ids),
    )).all()
    return {row.id: (row.journal_date, row.content) for row in rows} == {
        identifier: (day, content) for identifier, day, content in context.snapshot
    }
