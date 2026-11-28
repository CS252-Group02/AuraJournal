import json
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

from groq import APIStatusError, APITimeoutError, AuthenticationError, RateLimitError
from fastapi.testclient import TestClient
import httpx
import pytest

from app.schemas.reflection_chat import ReflectionTurnRequest
from app.auth import COOKIE_NAME
from app.services._groq import (
    AIInvalidResponseError, AIRateLimitError, AIServiceNotConfiguredError, AIServiceUnavailableError,
)
from app.services import reflection_chat
from app.services.reflection_chat import ReflectionChatAssistant
from test_account_data import HEADERS, register
from test_api import application_for
from test_reflection_chat import PATH, payload
from test_reflection_chat_journals import set_access, write_journal

PRIMARY = 'openai/gpt-oss-120b'
FALLBACK = 'openai/gpt-oss-20b'
ROUTE = {'outcome': 'reflection', 'search_context': 'current_message'}
REPLY = {'reply': 'You took a walk. What stood out?', 'source_ids': []}
PROVIDER_REQUEST = httpx.Request('POST', 'https://api.groq.com/openai/v1/chat/completions')


class Completions:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.calls.append(kwargs)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        content = response if isinstance(response, str) else json.dumps(response)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def status_error(status, *, code=None, error_type=APIStatusError):
    return error_type('private error body', response=httpx.Response(status, request=PROVIDER_REQUEST),
                      body={'error': {'code': code, 'failed_generation': 'private chat content'}})


def turn():
    return ReflectionTurnRequest(turn_id=uuid4(), expected_revision=0, message='I took a walk.', locale='en')


def wait_for_provider(entered, sending):
    completed, _ = wait((entered, sending), timeout=8, return_when=FIRST_COMPLETED)
    if sending in completed:
        # Propagate request exceptions instead of hiding them behind a timeout.
        response = sending.result()
        pytest.fail(f'Request finished before the provider checkpoint: HTTP {response.status_code}.')
    assert entered in completed, 'Timed out waiting for the provider checkpoint.'
    entered.result()


@pytest.mark.parametrize(('error', 'expected', 'message'), [
    (AssertionError('provider precondition failed'), AssertionError, 'provider precondition failed'),
    (AIServiceUnavailableError('provider unavailable'), pytest.fail.Exception, 'HTTP 503'),
])
def test_provider_checkpoint_surfaces_early_request_failure(migrated_engine, error, expected, message):
    app = application_for(migrated_engine)
    app.state.reflection_chat_assistant = ReflectionChatAssistant(Completions(error), model=PRIMARY)
    entered = Future()
    with TestClient(app, headers=HEADERS) as alice:
        register(alice, 'alice')
        path = f'{PATH}/{alice.post(PATH, json={}).json()["id"]}'
        with ThreadPoolExecutor() as pool:
            sending = pool.submit(alice.post, path + '/turns', json=payload())
            with pytest.raises(expected, match=message):
                wait_for_provider(entered, sending)
        assert not entered.done()


def test_recovers_only_failed_steps_with_strict_outputs_and_safe_logs(caplog):
    transport = Completions(ROUTE, 'broken JSON', REPLY, APITimeoutError(request=PROVIDER_REQUEST), {'approved': True})
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    assert assistant.classify(turn(), []).outcome == 'reflection'
    assert assistant.reflect(turn(), [], []).reply == REPLY['reply']
    assert [call['model'] for call in transport.calls] == [PRIMARY, PRIMARY, FALLBACK, PRIMARY, FALLBACK]
    wire = [call['response_format']['json_schema'] for call in transport.calls]
    assert [schema['name'] for schema in wire] == ['RoutingDecision', 'GeneratedReflection', 'GeneratedReflection',
                                                  'ReflectionReview', 'ReflectionReview']
    assert all(schema['strict'] and not schema['schema']['additionalProperties'] for schema in wire)
    assert all(0 < call['timeout'] <= 10 for call in transport.calls)
    assert 'ReflectionReview' in caplog.text
    assert 'I took a walk' not in caplog.text


def test_retries_same_model_for_upstream_5xx_when_fallback_is_unset():
    transport = Completions(status_error(502), ROUTE)
    assistant = ReflectionChatAssistant(transport, model='other-model', fallback_model='')
    assert assistant.classify(turn(), []).outcome == 'reflection'
    assert [call['model'] for call in transport.calls] == ['other-model'] * 2
    assert all(call['response_format'] == {'type': 'json_object'} for call in transport.calls)


def test_provider_json_failure_has_one_retry_and_safe_error(caplog):
    error = status_error(400, code='json_validate_failed')
    transport = Completions(error, error)
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with pytest.raises(AIInvalidResponseError):
        assistant.classify(turn(), [])
    assert [call['model'] for call in transport.calls] == [PRIMARY, FALLBACK]
    assert 'private error body' not in caplog.text
    assert 'private chat content' not in caplog.text


@pytest.mark.parametrize(('error', 'expected'), [
    (status_error(429, error_type=RateLimitError), AIRateLimitError),
    (status_error(401, error_type=AuthenticationError), AIServiceNotConfiguredError),
    (status_error(400, code='invalid_request_error'), AIServiceUnavailableError),
])
def test_final_provider_errors_skip_fallback(error, expected):
    transport = Completions(error)
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with pytest.raises(expected):
        assistant.classify(turn(), [])
    assert len(transport.calls) == 1


def test_reviewer_rejection_is_final():
    transport = Completions(REPLY, {'approved': False})
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with pytest.raises(AIInvalidResponseError, match='failed review'):
        assistant.reflect(turn(), [], [])
    assert [call['model'] for call in transport.calls] == [PRIMARY, PRIMARY]


def test_invalid_candidate_can_be_replaced_but_only_reviewed_reply_is_returned():
    transport = Completions({'reply': 'What changed? What happened?', 'source_ids': []}, REPLY, {'approved': True})
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    assert assistant.reflect(turn(), [], []).reply == REPLY['reply']
    assert [call['model'] for call in transport.calls] == [PRIMARY, FALLBACK, PRIMARY]
    assert json.loads(transport.calls[-1]['messages'][1]['content'])['candidate_reply'] == REPLY


def test_deadline_discards_late_results_and_skips_fallback(monkeypatch):
    ticks = iter([29.5, 30.1, 30.1])
    monkeypatch.setattr(reflection_chat, 'monotonic', lambda: next(ticks))
    transport = Completions(ROUTE)
    assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with pytest.raises(AIServiceUnavailableError, match='deadline'):
        assistant.classify(turn(), [], deadline=30)
    assert len(transport.calls) == 1 and transport.calls[0]['timeout'] == 0.5


def test_opt_out_stops_resending_prepared_excerpts(migrated_engine):
    entered, release = Future(), Event()

    class BlockGeneration(Completions):
        def create(self, **kwargs):
            if kwargs['response_format']['json_schema']['name'] == 'GeneratedReflection':
                entered.set_result(None)
                assert release.wait(10)
            return super().create(**kwargs)

    transport = BlockGeneration(ROUTE, status_error(502))
    app = application_for(migrated_engine)
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with TestClient(app, headers=HEADERS) as alice, TestClient(app, headers=HEADERS) as second_tab:
        register(alice, 'alice')
        second_tab.cookies.set(COOKIE_NAME, alice.cookies.get(COOKIE_NAME))
        write_journal(alice)
        path = f'{PATH}/{alice.post(PATH, json={}).json()["id"]}'
        assert set_access(alice, path, True, 0).status_code == 200
        with ThreadPoolExecutor() as pool:
            sending = pool.submit(alice.post, path + '/turns', json=payload('Harbor.'))
            try:
                wait_for_provider(entered, sending)
                assert set_access(second_tab, path, False, 1).status_code == 200
            finally:
                release.set()
            assert sending.result(timeout=10).status_code == 409
        assert [call['model'] for call in transport.calls] == [PRIMARY, PRIMARY]
        assert alice.get(path).json()['turns'] == []



def test_retry_stops_when_another_tab_advances_revision(migrated_engine):
    entered, release = Future(), Event()
    stale_message = 'I took a walk.'
    current_message = 'I read a book.'

    class RacingCompletions(Completions):
        def __init__(self):
            super().__init__()
            self.steps = []

        def create(self, **kwargs):
            step = kwargs['response_format']['json_schema']['name']
            message = json.loads(kwargs['messages'][1]['content'])['message']
            self.steps.append((message, step))
            if message == stale_message and step == 'RoutingDecision':
                entered.set_result(None)
                assert release.wait(10)
                raise status_error(502)
            result = {
                'RoutingDecision': ROUTE,
                'GeneratedReflection': {'reply': 'What stood out about the book?', 'source_ids': []},
                'ReflectionReview': {'approved': True},
            }[step]
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(result)))])

    transport = RacingCompletions()
    app = application_for(migrated_engine)
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport, model=PRIMARY, fallback_model=FALLBACK)
    with TestClient(app, headers=HEADERS) as alice, TestClient(app, headers=HEADERS) as second_tab:
        register(alice, 'alice')
        second_tab.cookies.set(COOKIE_NAME, alice.cookies.get(COOKIE_NAME))
        path = f'{PATH}/{alice.post(PATH, json={}).json()["id"]}'
        current = payload(current_message)
        with ThreadPoolExecutor() as pool:
            sending = pool.submit(alice.post, path + '/turns', json=payload(stale_message))
            try:
                wait_for_provider(entered, sending)
                saved = second_tab.post(path + '/turns', json=current)
                assert saved.status_code == 200
            finally:
                release.set()
            assert sending.result(timeout=10).status_code == 409

        assert [step for message, step in transport.steps if message == stale_message] == ['RoutingDecision']
        assert alice.get(path).json()['turns'] == [saved.json()]
        count = len(transport.steps)
        assert alice.post(path + '/turns', json=current).json() == saved.json()
        assert len(transport.steps) == count



@pytest.mark.parametrize(('change', 'expected_status'), [
    ('opt_out', 409), ('edit', 409), ('delete', 409), ('logout', 401), ('none', 200),
])
def test_first_review_rechecks_journal_context_after_successful_generation(migrated_engine, change, expected_status):
    entered, release = Future(), Event()

    class BlockGeneration(Completions):
        def create(self, **kwargs):
            assert migrated_engine.pool.checkedout() == 0
            if kwargs['response_format']['json_schema']['name'] == 'GeneratedReflection':
                assert json.loads(kwargs['messages'][1]['content'])['journal_excerpts']
                entered.set_result(None)
                assert release.wait(10)
            return super().create(**kwargs)

    transport = BlockGeneration(ROUTE, REPLY, {'approved': True})
    app = application_for(migrated_engine)
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport, model=PRIMARY)
    with TestClient(app, headers=HEADERS) as alice, TestClient(app, headers=HEADERS) as second_tab:
        _, credentials = register(alice, 'alice')
        second_tab.cookies.set(COOKIE_NAME, alice.cookies.get(COOKIE_NAME))
        entry = write_journal(alice)
        path = f'{PATH}/{alice.post(PATH, json={}).json()["id"]}'
        assert set_access(alice, path, True, 0).status_code == 200
        with ThreadPoolExecutor() as pool:
            sending = pool.submit(alice.post, path + '/turns', json=payload('Harbor.'))
            try:
                wait_for_provider(entered, sending)
                if change == 'opt_out':
                    assert set_access(second_tab, path, False, 1).status_code == 200
                elif change == 'edit':
                    assert second_tab.patch(f'/api/entries/{entry}', json={'content': 'Updated entry.'}).status_code == 200
                elif change == 'delete':
                    assert second_tab.request('DELETE', f'/api/entries/{entry}', json={}).status_code == 204
                elif change == 'logout':
                    assert second_tab.post('/api/auth/logout', json={}).status_code == 204
            finally:
                release.set()
            response = sending.result(timeout=10)
        assert response.status_code == expected_status
        steps = [call['response_format']['json_schema']['name'] for call in transport.calls]
        assert steps == ['RoutingDecision', 'GeneratedReflection'] + (['ReflectionReview'] if change == 'none' else [])
        if change == 'logout':
            # Read as the same owner through a fresh login after revoking the old session.
            assert alice.post('/api/auth/login', json=credentials).status_code == 200
        assert alice.get(path).json()['turns'] == ([response.json()] if change == 'none' else [])
