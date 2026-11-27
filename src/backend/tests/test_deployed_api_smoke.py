from pathlib import Path
import runpy

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from app.models import JournalEntry, User, WeeklyReflection
from app.services.deepgram import DeepgramStreamingClient
from test_api import application_for
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result
from test_transcription_upload import RecordedFixtureClient, AUDIO


RUNNER = runpy.run_path(str(Path(__file__).resolve().parents[3] / "scripts" / "smoke-api.py"))


class ReflectionGenerator:
    def generate(self, sources):
        assert len(sources) == 1
        return {
            "summary": "You walked around the lake.",
            "questions": ["What stood out about the lake?", "What did you see on your walk?"],
            "source_dates": [sources[0]["journal_date"]],
        }


@pytest.mark.parametrize("scenario", ["normal", "reflection-unavailable", "unexpected-provider-failure"])
def test_smoke_runner_against_real_routes_and_database(migrated_engine, scenario):
    app = application_for(migrated_engine)
    if scenario == "normal":
        socket = FakeSocket(final_events=[result("I took a walk.", final=True), {"type": "Metadata"}])
        app.state.deepgram_recording_client = RecordedFixtureClient(DeepgramStreamingClient("test-key", connector=FakeConnector(socket)))
        app.state.weekly_reflection_generator = ReflectionGenerator()
    else:
        app.state.weekly_reflection_generator = None
    with TestClient(app, headers={"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1"}) as client:
        if scenario == "unexpected-provider-failure":
            app.state.weekly_reflection_generator = ReflectionGenerator()
            with pytest.raises(RUNNER["SmokeFailure"], match="returned HTTP 200, expected 503"):
                RUNNER["run"](client, "reflection-unavailable", None)
        else:
            RUNNER["run"](client, scenario, AUDIO)
    with app.state.session_factory() as session:
        assert session.scalar(select(User.id).where(User.email.startswith("api-smoke-"))) is None
        assert session.scalar(select(JournalEntry.id)) is None
        assert session.scalar(select(WeeklyReflection.user_id)) is None
