import json
import asyncio

import pytest

from app.services import AIInvalidResponseError, AIServiceNotConfiguredError
from app.services.weekly_reflection import GroqWeeklyReflectionGenerator, WeeklyReflectionTooLarge
from test_ai_service import FakeCompletions, client_for
from test_api import app, request  # noqa: F401 - authenticated database fixture

SOURCES = [{"id": "00000000-0000-4000-8000-000000000016", "journal_date": "2026-11-16", "content": "I finished my exam."}]
OUTPUT = {"summary": "You completed an exam.", "questions": ["What helped?", "What would you repeat?"], "source_dates": ["2026-11-16"]}


def test_provider_sends_only_supplied_sources_and_validates_result():
    fake = FakeCompletions(json.dumps(OUTPUT))
    result = GroqWeeklyReflectionGenerator(client=client_for(fake)).generate(SOURCES)
    assert result.model_dump(mode="json") == OUTPUT
    assert json.loads(fake.calls[0]['messages'][1]['content']) == {'entries': SOURCES}


@pytest.mark.parametrize('output', [{**OUTPUT, 'questions': ['Only one?']},
                                    {**OUTPUT, 'summary': ' '}, {**OUTPUT, 'extra': 'field'}])
def test_invalid_output_is_rejected(output):
    with pytest.raises(AIInvalidResponseError):
        GroqWeeklyReflectionGenerator(client=client_for(FakeCompletions(json.dumps(output)))).generate(SOURCES)


def test_budget_rejects_without_provider_call():
    fake = FakeCompletions(json.dumps(OUTPUT))
    with pytest.raises(WeeklyReflectionTooLarge):
        GroqWeeklyReflectionGenerator(client=client_for(fake)).generate([{**SOURCES[0], 'content': 'x' * 60001}])
    assert not fake.calls


def test_missing_configuration_is_controlled(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    with pytest.raises(AIServiceNotConfiguredError):
        GroqWeeklyReflectionGenerator().generate(SOURCES)


def test_default_provider_saves_and_reads_validated_output(app):
    generator = app.state.weekly_reflection_generator
    assert isinstance(generator, GroqWeeklyReflectionGenerator)
    generator._ai._client = client_for(FakeCompletions(json.dumps(OUTPUT)))
    entry = asyncio.run(request(app, 'POST', '/api/entries', json={
        'content': 'I finished my exam.', 'journal_date': '2026-11-16'}))
    assert entry.status_code == 201
    response = asyncio.run(request(app, 'POST', '/api/weekly-reflections', json={
        'period_start': '2026-11-16'}))
    assert response.status_code == 200
    saved = asyncio.run(request(app, 'GET', '/api/weekly-reflections/2026-11-16'))
    assert saved.status_code == 200
    assert saved.json()['summary'] == OUTPUT['summary']
    assert saved.json()['questions'] == OUTPUT['questions']
