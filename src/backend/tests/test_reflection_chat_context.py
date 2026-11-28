import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from app.services.reflection_chat import ReflectionChatAssistant
from test_account_data import HEADERS, register
from test_api import application_for
from test_reflection_chat import PATH, payload
from test_reflection_chat_journals import set_access, write_journal


class CapturingGroq:
    def __init__(self):
        self.requests = []
        self.routing = {'outcome': 'reflection'}
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, messages, **kwargs):
        data = json.loads(messages[1]['content'])
        self.requests.append(data)
        if 'candidate_reply' in data:
            result = {'approved': True}
        elif 'journal_excerpts' in data:
            result = {'reply': 'What detail would you like to revisit?',
                      'source_ids': [source['id'] for source in data['journal_excerpts'][:1]]}
        else:
            result = self.routing
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(result)))])


def chat_path(client):
    response = client.post(PATH, json={})
    assert response.status_code == 201
    return f'{PATH}/{response.json()["id"]}'


def test_provider_receives_context_after_login_and_never_from_another_chat(migrated_engine):
    app = application_for(migrated_engine)
    transport = CapturingGroq()
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport)
    with TestClient(app, headers=HEADERS) as alice, TestClient(app, headers=HEADERS) as bob:
        _, credentials = register(alice, 'alice')
        register(bob, 'bob')
        alice_chat = chat_path(alice)
        first = payload('I put my phone away at lunch so I could listen to my sister.')
        saved = alice.post(alice_chat + '/turns', json=first)
        assert saved.status_code == 200
        assert alice.post('/api/auth/logout', json={}).status_code == 204
        assert alice.post('/api/auth/login', json=credentials).status_code == 200

        transport.requests.clear()
        follow_up = payload('What was different that time?', revision=1)
        assert alice.post(alice_chat + '/turns', json=follow_up).status_code == 200
        history = [{'message': first['message'], 'reply': saved.json()['reply']}]
        assert len(transport.requests) == 3
        assert all(data['message'] == follow_up['message'] and data['history'] == history for data in transport.requests)
        assert 'journal_excerpts' not in transport.requests[0]

        transport.requests.clear()
        other_chat = chat_path(alice)
        assert alice.post(other_chat + '/turns', json=payload('Different topic.')).status_code == 200
        assert all(data['history'] == [] for data in transport.requests)

        transport.requests.clear()
        transport.routing['search_context'] = 'previous_user_message'
        assert bob.post(alice_chat + '/turns', json=payload('Try another chat.')).status_code == 404
        assert transport.requests == []
        bob_chat = chat_path(bob)
        assert set_access(bob, bob_chat, True, 0).status_code == 200
        assert bob.post(bob_chat + '/turns', json=payload('My own reflection.')).status_code == 200
        assert len(transport.requests) == 3
        assert all(data['history'] == [] for data in transport.requests)


def test_provider_does_not_receive_journal_grounded_history_after_opt_out(migrated_engine):
    app = application_for(migrated_engine)
    transport = CapturingGroq()
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport)
    with TestClient(app, headers=HEADERS) as client:
        register(client, 'alice')
        path = chat_path(client)
        chat_only = client.post(path + '/turns', json=payload('I am thinking about my afternoon.')).json()
        entry_id = write_journal(client, 'I noticed unusual blue boats in the harbor.')
        assert set_access(client, path, True, 0).status_code == 200
        transport.requests.clear()
        grounded = client.post(path + '/turns', json=payload('Harbor boats.', revision=1)).json()
        assert grounded['sources'][0]['entry_id'] == entry_id
        assert 'journal_excerpts' not in transport.requests[0]
        assert transport.requests[1]['journal_excerpts'][0]['id'] == entry_id
        assert set_access(client, path, False, 1).status_code == 200

        transport.requests.clear()
        transport.routing['search_context'] = 'previous_user_message'
        assert client.post(path + '/turns', json=payload('What about that?', revision=2)).status_code == 200
        ordinary_history = [{'message': chat_only['message'], 'reply': chat_only['reply']}]
        assert len(transport.requests) == 3
        for data in transport.requests:
            assert data['history'] == ordinary_history
            assert data.get('journal_excerpts', []) == []
        assert client.get(path).json()['turns'][1]['message'] == grounded['message']


@pytest.mark.parametrize(('locale', 'prior', 'follow_up'), [
    ('en', 'I was thinking about harbor boats on 2024-02-29.', 'What changed after that?'),
    ('vi', 'Mình đang nghĩ về bến cảng và thuyền xanh ngày 2024-02-29.', 'Rồi lúc đó thì sao?'),
    ('vi', 'Mình đang nghĩ về harbor boats hôm 2024-02-29.', 'And after that thì sao?'),
])
def test_opted_in_follow_up_uses_prior_user_topic_without_inheriting_its_date(migrated_engine, locale, prior, follow_up):
    app = application_for(migrated_engine)
    transport = CapturingGroq()
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport)
    with TestClient(app, headers=HEADERS) as client:
        register(client, 'alice')
        old_entry = write_journal(client, 'Lunch on the balcony.', '2024-02-29')
        relevant = write_journal(client, 'Harbor boats. Thuyền xanh ở bến cảng.', '2024-03-02')
        path = chat_path(client)
        assert set_access(client, path, True, 0).status_code == 200
        assert client.post(path + '/turns', json=payload(prior, locale=locale)).json()['sources'][0]['entry_id'] == old_entry

        transport.requests.clear()
        transport.routing['search_context'] = 'previous_user_message'
        result = client.post(path + '/turns', json=payload(follow_up, revision=1, locale=locale))
        assert result.status_code == 200
        assert result.json()['sources'] == [{'entry_id': relevant, 'journal_date': '2024-03-02'}]
        route, generation, review = transport.requests
        assert route == {'message': follow_up, 'history': [], 'locale': locale}
        assert generation['message'] == review['message'] == follow_up
        assert [item['id'] for item in generation['journal_excerpts']] == [relevant]


def test_default_topic_change_dates_and_missing_history(migrated_engine):
    app = application_for(migrated_engine)
    transport = CapturingGroq()
    app.state.reflection_chat_assistant = ReflectionChatAssistant(transport)
    with TestClient(app, headers=HEADERS) as client:
        register(client, 'alice')
        harbor = write_journal(client, 'The harbor boats were blue.', '2024-02-27')
        garden = write_journal(client, 'I planted basil in the garden.', '2024-03-01')
        path = chat_path(client)
        assert set_access(client, path, True, 0).status_code == 200
        transport.routing['search_context'] = 'previous_user_message'
        assert client.post(path + '/turns', json=payload('What changed after that?')).json()['sources'] == []
        assert client.post(path + '/turns', json=payload('Harbor boats.', revision=1)).json()['sources'][0]['entry_id'] == harbor

        # Simulate an older provider reply that omits the new field.
        del transport.routing['search_context']
        new_topic = client.post(path + '/turns', json=payload('New topic. Garden basil.', revision=2)).json()
        assert [item['id'] for item in transport.requests[-2]['journal_excerpts']] == [garden]
        assert new_topic['sources'][0]['entry_id'] == garden

        transport.routing['search_context'] = 'previous_user_message'
        for revision, query in enumerate(('What did I write on 2024-02-27?', 'Look back from 2024-02-27 to 2024-02-28.'), start=3):
            result = client.post(path + '/turns', json=payload(query, revision=revision))
            assert result.status_code == 200
            assert result.json()['sources'][0]['entry_id'] == harbor
            assert [item['id'] for item in transport.requests[-2]['journal_excerpts']] == [harbor]
