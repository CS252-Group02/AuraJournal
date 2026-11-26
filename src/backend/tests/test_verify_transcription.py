import json

import pytest

from app.services import RecordedTranscript
from scripts import verify_transcription as runner


@pytest.fixture
def inputs(tmp_path, monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    audio = tmp_path / "browser.webm"
    audio.write_bytes(runner.WEBM_SIGNATURE + b"fictional Opus bytes")
    return audio, [str(audio), "--env-file", str(tmp_path / "missing.env")]


def test_missing_configuration_does_not_invoke_the_provider(inputs, monkeypatch, capsys):
    def forbidden(*args):
        pytest.fail("Missing configuration must not invoke the provider.")

    monkeypatch.setattr(runner, "verify", forbidden)
    assert runner.main(inputs[1]) == 2
    assert "DEEPGRAM_API_KEY is unavailable" in capsys.readouterr().err


@pytest.mark.parametrize("invalid", [b"", b"RIFFwav-data", runner.WEBM_SIGNATURE + b"x" * 20])
def test_invalid_local_audio_is_rejected_before_any_provider_call(inputs, monkeypatch, invalid):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")
    monkeypatch.setattr(runner, "MAX_AUDIO_BYTES", 20)
    inputs[0].write_bytes(invalid)

    def forbidden(*args):
        pytest.fail("Invalid input must not invoke the provider.")

    monkeypatch.setattr(runner, "verify", forbidden)
    assert runner.main(inputs[1]) == 2


def test_report_is_explicit_and_existing_reports_are_not_overwritten(inputs, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")
    calls = []

    async def verify(audio):
        calls.append(audio)
        return RecordedTranscript("Private fictional transcript.", "transcribed")

    monkeypatch.setattr(runner, "verify", verify)
    report = tmp_path / "report.json"
    assert runner.main(inputs[1] + ["--output", str(report)]) == 0
    assert json.loads(report.read_text(encoding="utf-8"))["transcript"] == "Private fictional transcript."
    assert "Private" not in capsys.readouterr().out
    assert runner.main(inputs[1] + ["--output", str(report)]) == 2
    assert len(calls) == 1


def test_unexpected_outcome_fails_and_cer_preserves_vietnamese_accents(inputs, monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")

    async def silence(audio):
        return RecordedTranscript("", "no_speech")

    monkeypatch.setattr(runner, "verify", silence)
    assert runner.main(inputs[1]) == 1
    assert runner.main(inputs[1] + ["--expect", "no_speech"]) == 0
    assert runner.character_error_rate("Hôm nay!", "HÔM   NAY.") == 0
    assert runner.character_error_rate("học", "hoc") > 0



def test_verification_uses_prerecorded_client_without_streaming(monkeypatch):
    import asyncio
    calls = []
    class Client:
        async def transcribe(self, audio):
            calls.append(audio)
            return RecordedTranscript("", "no_speech")
    monkeypatch.setattr(runner, "DeepgramRecordedClient", Client)
    assert asyncio.run(runner.verify(b"local audio")).outcome == "no_speech"
    assert calls == [b"local audio"]
