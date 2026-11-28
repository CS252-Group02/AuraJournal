from base64 import urlsafe_b64decode, urlsafe_b64encode
from binascii import Error as Base64Error
from collections import defaultdict
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session, aliased

from app.ai_errors import ai_service_error
from app.auth import COOKIE_NAME, current_user, digest, revalidate_session_owner, utcnow
from app.database import get_session
from app.limits import consume_ai_budget
from app.models import AuthSession, JournalEntry, ReflectionChat, ReflectionChatMessage, ReflectionChatSource, User
from app.schemas.reflection_chat import (
    Locale, ReflectionChatAccess, ReflectionChatDetail, ReflectionChatList, ReflectionChatMetadata,
    ReflectionSource, ReflectionSupport, ReflectionTurn, ReflectionTurnRequest,
)
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.journal_retrieval import ReflectionJournalContext, lock_reflection_sources, retrieve_reflection_journals
from app.services.reflection_chat import is_direct_urgent
from app.services.reflection_support import BOUNDARY_COPY, support_for

router = APIRouter(prefix='/api/reflection-chats', tags=['reflection chats'])
CHAT_PAGE = 20
TURN_PAGE = 30
HISTORY_TURNS = 6
HISTORY_CHARS = 8000


def owned_chat(session: Session, owner: UUID, chat_id: UUID, *, lock: bool = False) -> ReflectionChat:
    query = select(ReflectionChat).where(ReflectionChat.id == chat_id, ReflectionChat.user_id == owner)
    chat = session.scalar(query.with_for_update() if lock else query)
    if chat is None:
        raise HTTPException(404, 'Reflection chat not found.')
    return chat


def read_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        timestamp, identifier = urlsafe_b64decode(cursor).decode('ascii').split('|')
        date = datetime.fromisoformat(timestamp)
        if date.tzinfo is None:
            raise ValueError
        return date, UUID(identifier)
    except (Base64Error, UnicodeError, ValueError):
        raise HTTPException(422, 'Invalid chat cursor.') from None


def encode_cursor(chat: ReflectionChat) -> str:
    return urlsafe_b64encode(f'{chat.updated_at.isoformat()}|{chat.id}'.encode('ascii')).decode('ascii')


def turn_response(user_message: ReflectionChatMessage, assistant_message: ReflectionChatMessage,
                  sources: list[ReflectionSource]) -> ReflectionTurn:
    outcome = assistant_message.outcome
    return ReflectionTurn(
        turn_id=user_message.turn_id, revision=user_message.revision, message=user_message.text,
        reply=assistant_message.text, outcome=outcome, created_at=user_message.created_at,
        support_kind=outcome if outcome in {'urgent_support', 'professional_support'} else None,
        sources=sources,
    )


def visible_sources(session: Session, owner: UUID, message_ids: list[UUID]) -> dict[UUID, list[ReflectionSource]]:
    if not message_ids:
        return {}
    source = ReflectionChatSource
    rows = session.scalars(select(source).join(JournalEntry, JournalEntry.id == source.entry_id).where(
        source.message_id.in_(message_ids), JournalEntry.user_id == owner,
        JournalEntry.journal_date == source.journal_date, JournalEntry.content_version == source.content_version,
    ).order_by(source.journal_date, source.entry_id)).all()
    sources = defaultdict(list)
    for row in rows:
        sources[row.message_id].append(ReflectionSource(entry_id=row.entry_id, journal_date=row.journal_date))
    return sources


def recent_messages(session: Session, chat: ReflectionChat, limit: int,
                    before: int | None = None, *, include_grounded: bool = True
                    ) -> list[tuple[ReflectionChatMessage, ReflectionChatMessage]]:
    query = select(ReflectionChatMessage).where(
        ReflectionChatMessage.chat_id == chat.id, ReflectionChatMessage.revision <= chat.revision,
    )
    if before is not None:
        query = query.where(ReflectionChatMessage.revision < before)
    if not include_grounded:
        grounded = aliased(ReflectionChatMessage)
        query = query.where(~select(grounded.id).where(
            grounded.chat_id == ReflectionChatMessage.chat_id, grounded.revision == ReflectionChatMessage.revision,
            grounded.role == 'assistant', grounded.journal_context_used,
        ).exists())
    rows = session.scalars(query.order_by(
        ReflectionChatMessage.revision.desc(), ReflectionChatMessage.role.desc(),
    ).limit(limit * 2)).all()
    return list(zip(rows[::2], rows[1::2], strict=True))


def prompt_history(session: Session, chat: ReflectionChat, *, include_grounded: bool = False
                   ) -> tuple[list[dict[str, str]], bool]:
    turns = []
    remaining = HISTORY_CHARS
    used_journals = False
    for user, assistant in recent_messages(session, chat, HISTORY_TURNS, include_grounded=include_grounded):
        size = len(user.text) + len(assistant.text)
        if size > remaining:
            break
        remaining -= size
        turns.append({'message': user.text, 'reply': assistant.text})
        used_journals |= assistant.journal_context_used
    return turns[::-1], used_journals


def completed_turn(session: Session, owner: UUID, chat_id: UUID, payload: ReflectionTurnRequest
                   ) -> ReflectionTurn | None:
    messages = session.scalars(select(ReflectionChatMessage).where(
        ReflectionChatMessage.chat_id == chat_id, ReflectionChatMessage.turn_id == payload.turn_id,
    ).order_by(ReflectionChatMessage.role.desc())).all()
    if not messages:
        return None
    user_message, assistant_message = messages
    if user_message.text != payload.message:
        raise HTTPException(409, 'This turn ID was already used for a different message.')
    sources = (visible_sources(session, owner, [assistant_message.id]).get(assistant_message.id, [])
               if assistant_message.journal_context_used else [])
    return turn_response(user_message, assistant_message, sources)


def require_revision(chat: ReflectionChat, revision: int) -> None:
    if chat.revision != revision:
        raise HTTPException(409, 'This conversation changed. Refresh it before sending another message.')


def require_access_version(chat: ReflectionChat, version: int) -> None:
    if chat.journal_access_version != version:
        raise HTTPException(409, 'Journal access changed. Refresh the conversation and try again.')


def guard_session_write(request: Request, session: Session, owner: UUID) -> None:
    revalidate_session_owner(request, session, owner)
    # Account deletion locks the user first. Hold compatible locks in that order
    # so either this save commits first or revocation is visible before the save.
    account = session.scalar(select(User.id).where(
        User.id == owner, ~User.password_hash.startswith('!'),
    ).with_for_update(read=True))
    expires_at = session.scalar(select(AuthSession.expires_at).where(
        AuthSession.token_hash == digest(request.cookies[COOKIE_NAME]), AuthSession.user_id == owner,
    ).with_for_update(read=True)) if account is not None else None
    if expires_at is None or expires_at <= utcnow():
        raise HTTPException(401, 'Please log in.')


@router.get('/support', response_model=ReflectionSupport)
def lookup_support(country: Annotated[str, Query(min_length=2, max_length=2, pattern='^[A-Za-z]{2}$')],
                   locale: Locale, user: User = Depends(current_user)):
    return support_for(country.upper(), locale)


@router.post('', response_model=ReflectionChatMetadata, status_code=201)
def create_chat(session: Session = Depends(get_session), user: User = Depends(current_user)):
    chat = ReflectionChat(user_id=user.id)
    session.add(chat)
    session.commit()
    return chat


@router.get('', response_model=ReflectionChatList)
def list_chats(cursor: Annotated[str | None, Query(max_length=128, pattern=r'^[A-Za-z0-9_\-=]+$')] = None,
               session: Session = Depends(get_session), user: User = Depends(current_user)):
    query = select(ReflectionChat).where(ReflectionChat.user_id == user.id)
    if cursor is not None:
        query = query.where(tuple_(ReflectionChat.updated_at, ReflectionChat.id) < read_cursor(cursor))
    rows = session.scalars(query.order_by(ReflectionChat.updated_at.desc(), ReflectionChat.id.desc())
                           .limit(CHAT_PAGE + 1)).all()
    return {'chats': rows[:CHAT_PAGE], 'next_cursor': encode_cursor(rows[CHAT_PAGE - 1]) if len(rows) > CHAT_PAGE else None}


@router.get('/{chat_id}', response_model=ReflectionChatDetail)
def read_chat(chat_id: UUID, before_revision: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
              session: Session = Depends(get_session), user: User = Depends(current_user)):
    chat = owned_chat(session, user.id, chat_id)
    rows = recent_messages(session, chat, TURN_PAGE + 1, before_revision)
    page = rows[:TURN_PAGE]
    sources = visible_sources(session, user.id, [assistant.id for _, assistant in page if assistant.journal_context_used])
    turns = [turn_response(user_message, assistant, sources.get(assistant.id, []))
             for user_message, assistant in reversed(page)]
    return {'chat': chat, 'turns': turns, 'next_before_revision': turns[0].revision if len(rows) > TURN_PAGE else None}


@router.patch('/{chat_id}', response_model=ReflectionChatMetadata)
def update_chat_access(chat_id: UUID, payload: ReflectionChatAccess,
                       session: Session = Depends(get_session), user: User = Depends(current_user)):
    chat = owned_chat(session, user.id, chat_id, lock=True)
    require_access_version(chat, payload.expected_journal_access_version)
    if chat.use_journals != payload.use_journals:
        chat.use_journals = payload.use_journals
        chat.journal_access_version += 1
    session.commit()
    return chat


@router.delete('/{chat_id}', status_code=204)
def delete_chat(chat_id: UUID, session: Session = Depends(get_session), user: User = Depends(current_user)):
    session.delete(owned_chat(session, user.id, chat_id, lock=True))
    session.commit()


@router.post('/{chat_id}/turns', response_model=ReflectionTurn)
def send_turn(chat_id: UUID, payload: ReflectionTurnRequest, request: Request,
              session: Session = Depends(get_session), user: User = Depends(current_user)):
    owner = user.id
    chat = owned_chat(session, owner, chat_id)
    replay = completed_turn(session, owner, chat_id, payload)
    if replay is not None:
        return replay
    require_revision(chat, payload.expected_revision)
    use_journals, access_version = chat.use_journals, chat.journal_access_version
    context = ReflectionJournalContext([], {})
    cited_ids = []
    used_history = False
    if is_direct_urgent(payload.message):
        outcome = 'urgent_support'
        reply = BOUNDARY_COPY[payload.locale][outcome]
    else:
        history, _ = prompt_history(session, chat)
        consume_ai_budget(request, user, session)
        session.rollback()
        assistant = request.app.state.reflection_chat_assistant
        try:
            decision = assistant.classify(payload, history)
            outcome = decision.outcome
            if outcome == 'reflection':
                if use_journals:
                    revalidate_session_owner(request, session, owner)
                    # Serialize the short retrieval with consent changes. Never
                    # hold the chat lock or a connection through provider work.
                    chat = owned_chat(session, owner, chat_id, lock=True)
                    replay = completed_turn(session, owner, chat_id, payload)
                    if replay is not None:
                        return replay
                    require_revision(chat, payload.expected_revision)
                    require_access_version(chat, access_version)
                    history, used_history = prompt_history(session, chat, include_grounded=True)
                    previous_message = (history[-1]['message']
                                        if decision.search_context == 'previous_user_message' and history else None)
                    context = retrieve_reflection_journals(session, owner, payload.message,
                                                           previous_user_message=previous_message)
                    session.rollback()
                result = assistant.reflect(payload, history, context.sources)
                reply, cited_ids = result.reply, result.source_ids
            else:
                reply = BOUNDARY_COPY[payload.locale][outcome]
        except (AIInvalidResponseError, ValidationError, AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
            raise ai_service_error(error, invalid_detail='AI service returned an invalid reflection.',
                                   unavailable_detail='Reflection chat is unavailable. Please try again later.') from None

    guard_session_write(request, session, owner)
    chat = owned_chat(session, owner, chat_id, lock=True)
    replay = completed_turn(session, owner, chat_id, payload)
    if replay is not None:
        return replay
    require_revision(chat, payload.expected_revision)
    require_access_version(chat, access_version)
    if not lock_reflection_sources(session, owner, context):
        raise HTTPException(409, 'A journal changed while preparing the reply. Please try again.')
    if chat.revision == 0:
        chat.title = ' '.join(payload.message.split())[:60]
    chat.revision += 1
    turn_key = {'chat_id': chat_id, 'turn_id': payload.turn_id, 'revision': chat.revision}
    user_message = ReflectionChatMessage(**turn_key, role='user', text=payload.message)
    assistant_message = ReflectionChatMessage(**turn_key, role='assistant', text=reply, outcome=outcome,
                                               journal_context_used=bool(context.sources) or used_history)
    session.add_all([user_message, assistant_message])
    sources = []
    if cited_ids:
        session.flush()
        for entry_id in cited_ids:
            journal_date, content_version = context.versions[entry_id]
            session.add(ReflectionChatSource(message_id=assistant_message.id, entry_id=entry_id,
                                             journal_date=journal_date, content_version=content_version))
            sources.append(ReflectionSource(entry_id=entry_id, journal_date=journal_date))
    session.commit()
    return turn_response(user_message, assistant_message, sorted(sources, key=lambda source: (source.journal_date, source.entry_id)))
