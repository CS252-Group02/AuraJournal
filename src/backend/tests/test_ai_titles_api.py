import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from groq import APIConnectionError, RateLimitError

from app.auth import current_user
from app.database import get_session
from app.main import create_app
from app.schemas.ai import JournalTitleResponse
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalTitleGenerator,
)
from test_ai_service import FakeCompletions, client_for
from test_api import request

ENDPOINT = "/api/ai/suggest-title"
HEADERS = {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1"}


@pytest.fixture
def title_app(monkeypatch):
    monkeypatch.setenv("FRONTEND_ORIGIN", HEADERS["Origin"])
    application = create_app("postgresql+psycopg://unused:unused@localhost:1/unused")
    assert isinstance(application.state.journal_title_generator, JournalTitleGenerator)

    # Authenticate independently so any database use by title generation fails.
    application.dependency_overrides[current_user] = lambda: SimpleNamespace(id="test-user")

    def forbid_database(*args, **kwargs):
        raise AssertionError("Title generation must not access the database.")

    application.dependency_overrides[get_session] = forbid_database
    application.state.session_factory = forbid_database
    monkeypatch.setattr(application.state.engine, "connect", forbid_database)
    application.title_completions = FakeCompletions(
        '{"suggested_title":"A Project Finally Completed"}'
    )
    application.state.journal_title_generator = JournalTitleGenerator(
        client=client_for(application.title_completions)
    )
    try:
        yield application
    finally:
        application.state.engine.dispose()


def test_title_endpoint_works_without_database_access(title_app):
    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={
        "content": "  Today I finally completed my project.  ",
    }))

    assert response.status_code == 200
    assert response.json() == {"suggested_title": "A Project Finally Completed"}
    assert JournalTitleResponse.model_validate_json(response.content).suggested_title == (
        "A Project Finally Completed"
    )
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/json"
    assert len(title_app.title_completions.calls) == 1
    assert title_app.title_completions.calls[0]["messages"][1]["content"] == (
        "Today I finally completed my project."
    )


def test_title_requests_do_not_reuse_previous_journal_or_result(title_app):
    first = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "First journal"}))
    title_app.title_completions.content = '{"suggested_title":"An Evening Walk Outside"}'
    second = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "Second journal"}))

    assert first.json() == {"suggested_title": "A Project Finally Completed"}
    assert second.json() == {"suggested_title": "An Evening Walk Outside"}
    assert [call["messages"][1]["content"] for call in title_app.title_completions.calls] == [
        "First journal", "Second journal",
    ]
    assert all(len(call["messages"]) == 2 for call in title_app.title_completions.calls)


@pytest.mark.parametrize("payload", [
    {}, {"content": ""}, {"content": " \n\t "}, {"content": None}, {"content": 123},
    {"content": ["journal"]}, {"content": "a" * 5001}, {"content": "a" * 5000 + " "},
    {"entry_id": "00000000-0000-4000-8000-000000000001"},
    {"content": "Journal", "entry_id": "00000000-0000-4000-8000-000000000001"},
    {"content": "Journal", "suggested_title": "Client-supplied title"},
])
def test_invalid_content_and_entry_ids_are_rejected_before_ai_call(title_app, payload):
    response = asyncio.run(request(title_app, "POST", ENDPOINT, json=payload))
    assert response.status_code == 422
    assert title_app.title_completions.calls == []
    assert response.headers["cache-control"] == "no-store"
    assert all("input" not in error for error in response.json()["detail"])


def test_content_limit_accepts_exactly_5000_characters(title_app):
    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "a" * 5000}))
    assert response.status_code == 200
    assert len(title_app.title_completions.calls[0]["messages"][1]["content"]) == 5000


@pytest.mark.parametrize("content", [
    "not json", '{"suggested_title":["One", "Two"]}',
    '{"suggested_title":"**A Project Completed**"}',
    '{"suggested_title":"Title","extra":"private provider detail"}',
])
def test_invalid_ai_response_returns_controlled_502(title_app, content):
    title_app.title_completions.content = content
    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "Private journal"}))
    assert response.status_code == 502
    assert response.json() == {"detail": "AI service returned an invalid response."}
    assert response.headers["cache-control"] == "no-store"


def test_missing_credentials_return_controlled_503(title_app, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    factory = Mock()
    monkeypatch.setattr("app.services.ai_title.Groq", factory)
    title_app.state.journal_title_generator = JournalTitleGenerator()

    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "Private journal"}))

    assert response.status_code == 503
    assert response.json() == {
        "detail": "AI title service is unavailable. Please try again later.",
    }
    factory.assert_not_called()


@pytest.mark.parametrize("error_kind", [APIConnectionError, RateLimitError])
def test_groq_connection_and_rate_limit_failures_return_503(title_app, error_kind):
    provider_request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    if error_kind is APIConnectionError:
        error = error_kind(request=provider_request)
    else:
        error = error_kind(
            "private provider detail",
            response=httpx.Response(429, request=provider_request), body=None,
        )
    title_app.title_completions.error = error

    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "Private journal"}))

    assert response.status_code == 503
    assert response.json() == {
        "detail": "AI title service is unavailable. Please try again later.",
    }


@pytest.mark.parametrize("error,status_code,detail", [
    (EmptyJournalError("private detail"), 422, "Journal content cannot be empty."),
    (AIInvalidResponseError("private detail"), 502, "AI service returned an invalid response."),
    (AIServiceNotConfiguredError("private detail"), 503,
     "AI title service is unavailable. Please try again later."),
    (AIServiceUnavailableError("private detail"), 503,
     "AI title service is unavailable. Please try again later."),
])
def test_service_errors_follow_existing_http_conventions(title_app, error, status_code, detail):
    title_app.state.journal_title_generator = SimpleNamespace(generate=Mock(side_effect=error))
    response = asyncio.run(request(title_app, "POST", ENDPOINT, json={"content": "Private journal"}))
    assert response.status_code == status_code
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize("headers,status_code", [
    ({}, 403),
    ({"Origin": HEADERS["Origin"]}, 403),
    ({**HEADERS, "Origin": "https://evil.example"}, 403),
    ({**HEADERS, "X-AuraJournal-CSRF": "wrong"}, 403),
    ({**HEADERS, "Content-Type": "text/plain"}, 415),
])
def test_title_endpoint_preserves_origin_csrf_and_json_checks(title_app, headers, status_code):
    response = asyncio.run(request(
        title_app, "POST", ENDPOINT, json={"content": "Private journal"}, headers=headers,
    ))
    assert response.status_code == status_code
    assert title_app.title_completions.calls == []


def test_openapi_contract_only_accepts_content_and_returns_one_title(title_app):
    schema = title_app.openapi()
    operation = schema["paths"][ENDPOINT]["post"]
    request_schema = schema["components"]["schemas"]["JournalTitleRequest"]
    response_schema = schema["components"]["schemas"]["JournalTitleResponse"]
    assert operation["requestBody"]["required"] is True
    assert request_schema["required"] == ["content"]
    assert set(request_schema["properties"]) == {"content"}
    assert request_schema["properties"]["content"]["maxLength"] == 5000
    assert request_schema["additionalProperties"] is False
    assert response_schema["required"] == ["suggested_title"]
    assert set(response_schema["properties"]) == {"suggested_title"}
    assert response_schema["properties"]["suggested_title"]["maxLength"] == 100
    assert response_schema["additionalProperties"] is False
