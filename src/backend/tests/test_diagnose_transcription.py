import asyncio
import json

import pytest

from scripts import diagnose_transcription as runner
from test_deepgram_service import FakeConnector, FakeSocket
from app.services import DeepgramStreamingClient
from test_transcription import result, word


def test_replay_identifies_validation_location_without_exception_text():
    event = result("PRIVATE", final=True, words=[word("PRIVATE", 0, 9)])
    output = runner.replay([{"event": event}])
    assert output["status"] == "failed" and output["event_index"] == 0
    assert any(frame["function"] == "_read_result" for frame in output["frames"])
    assert "PRIVATE" not in json.dumps(output)


def test_capture_uses_one_connection_and_replays_real_normalizer_offline():
    socket = FakeSocket(final_events=[result("A recorded sentence.", final=True), {"type": "Metadata"}])
    connector = FakeConnector(socket)
    report = {"events": [], "phases": []}
    asyncio.run(runner.capture(b"browser bytes", report, client=DeepgramStreamingClient("key", connector=connector)))
    assert len(connector.calls) == 1 and socket.close_calls == 1
    assert report["transport"]["status"] == "completed"
    assert report["replay"]["transcript"] == "A recorded sentence."
    assert "provider-only" not in json.dumps(report)
    assert "additional_headers" not in json.dumps(report)


def test_capture_still_collects_later_provider_events_after_mapping_failure():
    first = result("Invalid timing", final=True, words=[word("Invalid", 0, 9)])
    socket = FakeSocket(final_events=[first, result("Later.", start=3, end=4, final=True), {"type": "Metadata"}])
    report = {"events": [], "phases": []}
    asyncio.run(runner.capture(b"bytes", report, client=DeepgramStreamingClient("key", connector=FakeConnector(socket))))
    assert len(report["events"]) == 3
    assert report["transport"]["status"] == "completed"
    assert report["replay"]["status"] == "failed"


def test_cli_requires_live_before_any_call(tmp_path):
    with pytest.raises(SystemExit):
        runner.main([str(tmp_path/"audio.weba"), "--output", str(tmp_path/"report.json")])
    assert not (tmp_path/"report.json").exists()


def test_existing_report_prevents_another_call(tmp_path, monkeypatch):
    audio = tmp_path/"audio.weba"; audio.write_bytes(bytes.fromhex("1a45dfa3")+b"audio")
    report = tmp_path/"report.json"; report.write_text("existing",encoding="utf-8")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "key")
    monkeypatch.setattr(runner, "capture", lambda *args: pytest.fail("must not spend another call"))
    assert runner.main([str(audio), "--live", "--output", str(report)]) == 2
    assert report.read_text(encoding="utf-8") == "existing"


@pytest.mark.parametrize("value", ["0", "-1", "56", "nan", "inf"])
def test_invalid_diagnostic_flush_timeout_never_opens_a_connection(tmp_path, value):
    with pytest.raises(SystemExit):
        runner.main([str(tmp_path/"audio.weba"), "--live", "--finish-timeout", value,
                     "--output", str(tmp_path/"report.json")])
    assert not (tmp_path/"report.json").exists()



def test_diagnostic_replay_does_not_call_an_unconfirmed_draft_a_success():
    output = runner.replay([{"event": result("Unconfirmed", final=False)}])
    assert output["status"] == "incomplete"
    assert output["error_code"] == "invalid_response"
    assert output["transcript"] == ""
