from base64 import urlsafe_b64decode, urlsafe_b64encode
from binascii import Error as Base64Error
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.ai_errors import ai_service_error
from app.auth import COOKIE_NAME, current_user, digest, revalidate_session_owner, utcnow
from app.database import get_session
from app.limits import consume_ai_budget
from app.models import AuthSession, ReflectionChat, ReflectionChatMessage, User
from app.schemas.reflection_chat import (
    Locale, ReflectionChatDetail, ReflectionChatList, ReflectionChatMetadata,
    ReflectionSupport, ReflectionTurn, ReflectionTurnRequest,
)
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
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


def turn_response(user_message: ReflectionChatMessage, assistant_message: ReflectionChatMessage) -> ReflectionTurn:
    outcome = assistant_message.outcome
    return ReflectionTurn(
        turn_id=user_message.turn_id, revision=user_message.revision, message=user_message.text,
        reply=assistant_message.text, outcome=outcome, created_at=user_message.created_at,
        support_kind=outcome if outcome in {'urgent_support', 'professional_support'} else None,
    )


def recent_messages(session: Session, chat: ReflectionChat, limit: int,
                    before: int | None = None) -> list[tuple[ReflectionChatMessage, ReflectionChatMessage]]:
    query = select(ReflectionChatMessage).where(
        ReflectionChatMessage.chat_id == chat.id, ReflectionChatMessage.revision <= chat.revision,
    )
    if before is not None:
        query = query.where(ReflectionChatMessage.revision < before)
    rows = session.scalars(query.order_by(
        ReflectionChatMessage.revision.desc(), ReflectionChatMessage.role.desc(),
    ).limit(limit * 2)).all()
    return list(zip(rows[::2], rows[1::2], strict=True))


def prompt_history(session: Session, chat: ReflectionChat) -> list[dict[str, str]]:
    turns = []
    remaining = HISTORY_CHARS
    for user, assistant in recent_messages(session, chat, HISTORY_TURNS):
        size = len(user.text) + len(assistant.text)
        if size > remaining:
            break
        remaining -= size
        turns.append({'message': user.text, 'reply': assistant.text})
    return turns[::-1]


def completed_turn(session: Session, chat_id: UUID, payload: ReflectionTurnRequest) -> ReflectionTurn | None:
    messages = session.scalars(select(ReflectionChatMessage).where(
        ReflectionChatMessage.chat_id == chat_id, ReflectionChatMessage.turn_id == payload.turn_id,
    ).order_by(ReflectionChatMessage.role.desc())).all()
    if not messages:
        return None
    user_message, assistant_message = messages
    if user_message.text != payload.message:
        raise HTTPException(409, 'This turn ID was already used for a different message.')
    return turn_response(user_message, assistant_message)


def require_revision(chat: ReflectionChat, revision: int) -> None:
    if chat.revision != revision:
        raise HTTPException(409, 'This conversation changed. Refresh it before sending another message.')


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
    turns = [turn_response(*pair) for pair in reversed(rows[:TURN_PAGE])]
    return {'chat': chat, 'turns': turns, 'next_before_revision': turns[0].revision if len(rows) > TURN_PAGE else None}


@router.delete('/{chat_id}', status_code=204)
def delete_chat(chat_id: UUID, session: Session = Depends(get_session), user: User = Depends(current_user)):
    session.delete(owned_chat(session, user.id, chat_id, lock=True))
    session.commit()


@router.post('/{chat_id}/turns', response_model=ReflectionTurn)
def send_turn(chat_id: UUID, payload: ReflectionTurnRequest, request: Request,
              session: Session = Depends(get_session), user: User = Depends(current_user)):
    owner = user.id
    chat = owned_chat(session, owner, chat_id)
    replay = completed_turn(session, chat_id, payload)
    if replay is not None:
        return replay
    require_revision(chat, payload.expected_revision)

    if is_direct_urgent(payload.message):
        outcome = 'urgent_support'
        reply = BOUNDARY_COPY[payload.locale][outcome]
    else:
        history = prompt_history(session, chat)
        consume_ai_budget(request, user, session)
        session.rollback()
        try:
            outcome, reply = request.app.state.reflection_chat_assistant.respond(payload, history)
        except (AIInvalidResponseError, ValidationError, AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
            raise ai_service_error(error, invalid_detail='AI service returned an invalid reflection.',
                                   unavailable_detail='Reflection chat is unavailable. Please try again later.') from None

    guard_session_write(request, session, owner)
    chat = owned_chat(session, owner, chat_id, lock=True)
    replay = completed_turn(session, chat_id, payload)
    if replay is not None:
        return replay
    require_revision(chat, payload.expected_revision)
    if chat.revision == 0:
        chat.title = ' '.join(payload.message.split())[:60]
    chat.revision += 1
    turn_key = {'chat_id': chat_id, 'turn_id': payload.turn_id, 'revision': chat.revision}
    user_message = ReflectionChatMessage(**turn_key, role='user', text=payload.message)
    assistant_message = ReflectionChatMessage(**turn_key, role='assistant', text=reply, outcome=outcome)
    session.add_all([user_message, assistant_message])
    session.commit()
    return turn_response(user_message, assistant_message)
