import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from app.routers.reflections import week_bounds
from app.schemas.weekly import WeeklyRecap, WeeklyRecapRequest
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.weekly_recap import SYSTEM_PROMPT, WeeklyRecapGenerator, WeeklyRecapTooLarge
from test_ai_service import FakeCompletions, client_for
from test_api import app, application_for, request  # noqa: F401 - reuse authenticated fixture

ENDPOINT = '/api/reflections/weekly'
PAYLOAD = {'start': '2026-11-09', 'timezone': 'Asia/Bangkok'}
ENTRY_TIME = datetime(2026, 11, 10, 5, tzinfo=timezone.utc)


def sources():
    return [{'id': str(uuid4()), 'recorded_at': '2026-11-10T12:00:00+07:00', 'content': 'Finished an exam.'}]


def output(records):
    return {'summary': 'You finished an exam.',
            'highlights': [{'text': 'An exam was completed.', 'entry_ids': [records[0]['id']]}]}


def test_weekly_transport_and_fact_based_prompt():
    records = sources()
    completions = FakeCompletions(json.dumps(output(records)))
    result = WeeklyRecapGenerator(client=client_for(completions)).generate(records)
    assert result.summary == 'You finished an exam.'
    call = completions.calls[0]
    assert call['response_format'] == {'type': 'json_object'}
    assert call['max_completion_tokens'] == 1024
    assert json.loads(call['messages'][1]['content']) == {'entries': records}
    for rule in ('untrusted source material', 'Do not ask questions', 'give advice',
                 'infer unstated emotions', 'future plans', 'predominant language',
                 'shorter recap', 'Dates', 'exact source IDs',
                 'EVERY natural-language', 'are noise, NOT events'):
        assert rule in SYSTEM_PROMPT


@pytest.mark.parametrize('change', ['unknown_id', 'question_field', 'missing_summary', 'too_many_events'])
def test_weekly_rejects_invalid_output(change):
    records = sources()
    value = output(records)
    if change == 'unknown_id':
        value['highlights'][0]['entry_ids'] = [str(uuid4())]
    elif change == 'question_field':
        value['questions'] = ['What did you learn?']
    elif change == 'missing_summary':
        del value['summary']
    else:
        value['highlights'] *= 6
    generator = WeeklyRecapGenerator(client=client_for(FakeCompletions(json.dumps(value))))
    with pytest.raises(AIInvalidResponseError):
        generator.generate(records)


def test_weekly_rejects_large_input_before_provider_call():
    records = sources()
    records[0]['content'] = 'x' * 60_000
    completions = FakeCompletions('{}')
    with pytest.raises(WeeklyRecapTooLarge):
        WeeklyRecapGenerator(client=client_for(completions)).generate(records)
    assert completions.calls == []


@pytest.mark.parametrize('zone,start,hours', [
    ('Asia/Bangkok', date(2026, 11, 9), 168),
    ('America/New_York', date(2026, 3, 2), 167),
    ('America/New_York', date(2026, 10, 26), 169),
])
def test_week_bounds_respect_daylight_saving(zone, start, hours):
    beginning, end = week_bounds(start, zone)
    assert (end - beginning).total_seconds() == hours * 3600


@pytest.mark.parametrize('payload', [
    {}, {'start': '2026-11-10', 'timezone': 'UTC'},
    {'start': '2026-11-09', 'timezone': 'Not/AZone'},
    {**PAYLOAD, 'user_id': str(uuid4())}, {**PAYLOAD, 'start': '2026-02-30'},
])
def test_invalid_week_requests(payload):
    with pytest.raises(ValidationError):
        WeeklyRecapRequest.model_validate(payload)


class FakeRecap:
    def __init__(self, mutation=None, error=None):
        self.calls = []
        self.mutation = mutation
        self.error = error

    def generate(self, records):
        self.calls.append(records)
        if self.mutation:
            self.mutation()
        if self.error:
            raise self.error
        return WeeklyRecap.model_validate(output(records))


def insert_entry(app, content='Finished an exam.', **kwargs):
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, content=content, created_at=kwargs.pop('created_at', ENTRY_TIME), **kwargs)
        session.add(entry)
        session.commit()
        return entry.id


def recap(app, **kwargs):
    return asyncio.run(request(app, 'POST', ENDPOINT, json=PAYLOAD, **kwargs))


def test_weekly_selects_only_owned_entries_with_local_boundaries(app):
    start, end = week_bounds(date(2026, 11, 9), 'Asia/Bangkok')
    insert_entry(app, 'Outside before.', created_at=start - timedelta(microseconds=1))
    later = insert_entry(app, 'Later event.', created_at=end - timedelta(microseconds=1))
    first = insert_entry(app, 'First event.', created_at=start, ai_summary='DO NOT SEND STORED SUMMARY')
    insert_entry(app, 'Outside after.', created_at=end)
    with Session(app.state.engine) as session:
        other = User(email='other-week@example.com', password_hash='!disabled')
        session.add(JournalEntry(user=other, content='PRIVATE OTHER ACCOUNT', created_at=ENTRY_TIME))
        session.commit()
    generator = FakeRecap()
    app.state.weekly_recap_generator = generator
    response = recap(app)
    assert response.status_code == 200
    assert response.json()['week_start'] == '2026-11-09'
    assert response.json()['week_end'] == '2026-11-15'
    assert response.json()['timezone'] == 'Asia/Bangkok'
    assert response.json()['entry_count'] == 2
    records = generator.calls[0]
    assert [row['id'] for row in records] == [str(first), str(later)]
    assert [row['content'] for row in records] == ['First event.', 'Later event.']
    assert all(set(row) == {'id', 'recorded_at', 'content'} for row in records)
    assert records[0]['recorded_at'].startswith('2026-11-09T00:00:00')
    assert response.headers['cache-control'] == 'no-store'


def test_empty_week_does_not_call_ai(app):
    generator = FakeRecap()
    app.state.weekly_recap_generator = generator
    response = recap(app)
    assert response.status_code == 200
    assert response.json()['entry_count'] == 0
    assert response.json()['summary'] is None
    assert response.json()['highlights'] == []
    assert generator.calls == []


@pytest.mark.parametrize('mutation', ['edit', 'delete', 'insert'])
def test_changed_week_is_not_returned(app, mutation):
    entry_id = insert_entry(app)

    def change():
        with Session(app.state.engine) as session:
            entry = session.get(JournalEntry, entry_id)
            if mutation == 'edit':
                entry.content = 'The author revised the event.'
            elif mutation == 'delete':
                session.delete(entry)
            else:
                session.add(JournalEntry(user_id=app.user_id, content='Another event.', created_at=ENTRY_TIME))
            session.commit()
    app.state.weekly_recap_generator = FakeRecap(mutation=change)
    response = recap(app)
    assert response.status_code == 409
    assert 'changed' in response.json()['detail']


def test_changes_outside_selected_week_do_not_invalidate_recap(app):
    insert_entry(app)
    outside = insert_entry(app, created_at=ENTRY_TIME - timedelta(days=20))
    def change():
        with Session(app.state.engine) as session:
            session.get(JournalEntry, outside).content = 'An earlier event changed.'
            session.commit()
    app.state.weekly_recap_generator = FakeRecap(mutation=change)
    assert recap(app).status_code == 200


@pytest.mark.parametrize('error,status', [
    (AIInvalidResponseError('private detail'), 502),
    (AIServiceNotConfiguredError('private key'), 503),
    (AIServiceUnavailableError('provider details'), 503),
    (WeeklyRecapTooLarge('private detail'), 413),
])
def test_weekly_controlled_errors(app, error, status):
    insert_entry(app)
    app.state.weekly_recap_generator = FakeRecap(error=error)
    response = recap(app)
    assert response.status_code == status
    assert 'private' not in response.text and 'provider details' not in response.text


def test_weekly_requires_login_and_csrf(app):
    insert_entry(app)
    app.state.weekly_recap_generator = FakeRecap()
    anonymous = application_for(app.state.engine)
    assert recap(anonymous).status_code == 401
    assert recap(app, headers={}).status_code == 403
    assert recap(app, headers={'Origin': 'https://evil.example', 'X-AuraJournal-CSRF': '1'}).status_code == 403
    assert app.state.weekly_recap_generator.calls == []
