import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import pytest
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosedOK, InvalidStatus
from websockets.frames import Close
from websockets.http11 import Response

from app.services.deepgram import (
    DeepgramConfigurationError,
    DeepgramInvalidResponseError,
    DeepgramStreamingClient,
    DeepgramTimeoutError,
    DeepgramUnavailableError,
)


def closed():
    return ConnectionClosedOK(Close(1000, ""), Close(1000, ""), True)


class FakeSocket:
    def __init__(self, final_events=None):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.close_calls = 0
        self.send_error = None
        self.final_events = final_events if final_events is not None else [{"type": "Metadata"}]

    async def send(self, message):
        if self.send_error:
            raise self.send_error
        self.sent.append(message)
        if isinstance(message, str) and json.loads(message)["type"] == "CloseStream":
            for event in self.final_events:
                self.incoming.put_nowait(json.dumps(event))

    async def recv(self):
        event = await self.incoming.get()
        if isinstance(event, BaseException):
            raise event
        return event

    async def close(self):
        self.close_calls += 1
        self.incoming.put_nowait(closed())


class FakeConnector:
    def __init__(self, socket=None, error=None):
        self.socket = socket or FakeSocket()
        self.error = error
        self.calls = []

    async def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error:
            raise self.error
        return self.socket


async def collect(stream):
    return [event async for event in stream.events()]


def test_stream_uses_backend_credentials_multilingual_options_and_unchanged_audio(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", " test-secret ")
    final = {"type": "Results", "is_final": True,
             "channel": {"alternatives": [{"transcript": "Hôm nay I finished my project."}]}}
    socket = FakeSocket(final_events=[final, {"type": "Metadata", "duration": 2.0}])
    partial = {"type": "Results", "is_final": False,
               "channel": {"alternatives": [{"transcript": "Hôm nay"}]}}
    socket.incoming.put_nowait(json.dumps(partial))
    connector = FakeConnector(socket)

    async def run():
        async with DeepgramStreamingClient(connector=connector).connect() as stream:
            receiver = asyncio.create_task(collect(stream))
            chunks = [b"webm-header", b"middle-opus", b"last-opus"]
            for chunk in chunks:
                await stream.send_audio(chunk)
            await stream.finish()
            assert await receiver == [partial, final, {"type": "Metadata", "duration": 2.0}]
        assert socket.sent == chunks + ['{"type": "CloseStream"}']
        assert socket.close_calls == 1

    asyncio.run(run())
    assert len(connector.calls) == 1
    url, options = connector.calls[0]
    parsed = urlsplit(url)
    assert (parsed.scheme, parsed.netloc, parsed.path) == ("wss", "api.deepgram.com", "/v1/listen")
    assert parse_qs(parsed.query) == {
        "model": ["nova-3"], "language": ["multi"], "language_hint": ["vi", "en"],
        "interim_results": ["true"], "endpointing": ["300"],
    }
    assert options["additional_headers"] == {"Authorization": "Token test-secret"}
    assert options["open_timeout"] == 10
    assert options["close_timeout"] == 2
    assert options["max_size"] == 1024 * 1024
    assert options["max_queue"] == 16
    assert options["compression"] is None and options["proxy"] is None
    assert "test-secret" not in url


@pytest.mark.parametrize("key", [None, "", "  ", "bad\r\nkey"])
def test_missing_or_unsafe_credentials_do_not_open_a_connection(monkeypatch, key):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    connector = FakeConnector()

    async def run():
        with pytest.raises(DeepgramConfigurationError):
            async with DeepgramStreamingClient(key, connector=connector).connect():
                pytest.fail("Invalid credentials must not open a stream.")

    asyncio.run(run())
    assert connector.calls == []


def test_explicit_key_overrides_environment_and_missing_key_does_not_break_construction(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "environment-key")
    connector = FakeConnector()

    async def run():
        async with DeepgramStreamingClient("explicit-key", connector=connector).connect():
            pass

    asyncio.run(run())
    assert connector.calls[0][1]["additional_headers"] == {"Authorization": "Token explicit-key"}
    monkeypatch.delenv("DEEPGRAM_API_KEY")
    DeepgramStreamingClient()  # Configuration is required only when starting a take.


@pytest.mark.parametrize("mime", ["audio/wav", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"])
def test_unagreed_format_is_rejected_before_connecting(mime):
    connector = FakeConnector()

    async def run():
        with pytest.raises(ValueError, match="format"):
            async with DeepgramStreamingClient("key", connector=connector).connect(mime_type=mime):
                pytest.fail("Unsupported format must not open a stream.")

    asyncio.run(run())
    assert connector.calls == []


@pytest.mark.parametrize("status,expected", [
    (401, DeepgramConfigurationError), (403, DeepgramConfigurationError),
    (429, DeepgramUnavailableError), (500, DeepgramUnavailableError),
])
def test_provider_handshake_errors_are_safe_and_never_retried(status, expected):
    connector = FakeConnector(error=InvalidStatus(Response(
        status, "private provider response", Headers(), body=b"private key and content",
    )))

    async def run():
        with pytest.raises(expected) as caught:
            async with DeepgramStreamingClient("key", connector=connector).connect():
                pytest.fail("Rejected handshake must not yield a stream.")
        assert "private" not in str(caught.value)

    asyncio.run(run())
    assert len(connector.calls) == 1


def test_network_failure_does_not_expose_connection_details():
    connector = FakeConnector(error=OSError("private host and key"))

    async def run():
        with pytest.raises(DeepgramUnavailableError, match="unavailable") as caught:
            async with DeepgramStreamingClient("key", connector=connector).connect():
                pass
        assert "private" not in str(caught.value)

    asyncio.run(run())
    assert len(connector.calls) == 1


def test_connection_timeout_cancels_the_attempt():
    cancelled = []

    async def stalled(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    async def run():
        with pytest.raises(DeepgramTimeoutError, match="connection"):
            async with DeepgramStreamingClient("key", connector=stalled, open_timeout=0.01).connect():
                pass

    asyncio.run(run())
    assert cancelled == [True]


def test_finish_is_idempotent_waits_for_final_events_and_rejects_new_audio():
    socket = FakeSocket(final_events=[])

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            receiver = asyncio.create_task(collect(stream))
            finishing = asyncio.create_task(stream.finish())
            # Wait until CloseStream has actually been written.
            while not socket.sent:
                await asyncio.sleep(0)
            assert not finishing.done()
            with pytest.raises(RuntimeError, match="no longer accepts"):
                await stream.send_audio(b"late audio")
            socket.incoming.put_nowait(json.dumps({"type": "Results", "is_final": True}))
            socket.incoming.put_nowait(json.dumps({"type": "Metadata"}))
            await asyncio.gather(finishing, stream.finish())
            assert [event["type"] for event in await receiver] == ["Results", "Metadata"]
            await stream.finish()
        assert socket.sent == ['{"type": "CloseStream"}']

    asyncio.run(run())


def test_silence_is_preserved_as_raw_empty_result_not_a_service_failure():
    empty = {"type": "Results", "is_final": True, "channel": {"alternatives": [{"transcript": ""}]}}
    socket = FakeSocket(final_events=[empty, {"type": "Metadata"}])

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            receiver = asyncio.create_task(collect(stream))
            await stream.finish()
            assert (await receiver)[0] == empty

    asyncio.run(run())


@pytest.mark.parametrize("raw,expected", [
    ("not JSON private", DeepgramInvalidResponseError),
    ("[]", DeepgramInvalidResponseError),
    ('{"transcript":"private"}', DeepgramInvalidResponseError),
    (b'{"type":"Results"}', DeepgramInvalidResponseError),
    ('{"type":"Error","description":"private audio and key"}', DeepgramUnavailableError),
    (closed(), DeepgramUnavailableError),
    (OSError("private connection"), DeepgramUnavailableError),
])
def test_bad_provider_events_and_early_disconnect_never_look_complete(raw, expected):
    socket = FakeSocket()
    socket.incoming.put_nowait(raw)

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            with pytest.raises(expected) as caught:
                await collect(stream)
            assert "private" not in str(caught.value)
            with pytest.raises(expected):
                await stream.finish()
        assert socket.close_calls == 1

    asyncio.run(run())


def test_finish_timeout_closes_socket_and_releases_receiver():
    socket = FakeSocket(final_events=[])

    async def run():
        client = DeepgramStreamingClient("key", connector=FakeConnector(socket), finish_timeout=0.01)
        async with client.connect() as stream:
            receiver = asyncio.create_task(collect(stream))
            with pytest.raises(DeepgramTimeoutError, match="completion"):
                await stream.finish()
            with pytest.raises(DeepgramTimeoutError, match="completion"):
                await receiver
        assert socket.close_calls == 1

    asyncio.run(run())


def test_finish_deadline_includes_sending_the_close_command():
    socket = FakeSocket()

    async def stalled_send(message):
        await asyncio.Event().wait()

    socket.send = stalled_send

    async def run():
        client = DeepgramStreamingClient("key", connector=FakeConnector(socket), finish_timeout=0.01)
        async with client.connect() as stream:
            receiver = asyncio.create_task(collect(stream))
            with pytest.raises(DeepgramTimeoutError, match="completion"):
                await stream.finish()
            with pytest.raises(DeepgramTimeoutError, match="completion"):
                await receiver
        assert socket.close_calls == 1

    asyncio.run(run())


def test_sender_failure_and_receiver_cancellation_release_the_connection():
    socket = FakeSocket()

    async def run():
        client = DeepgramStreamingClient("key", connector=FakeConnector(socket))
        with pytest.raises(DeepgramUnavailableError):
            async with client.connect() as stream:
                socket.send_error = OSError("private detail")
                await stream.send_audio(b"audio")
        assert socket.close_calls == 1

        second = FakeSocket()
        async def take():
            async with DeepgramStreamingClient("key", connector=FakeConnector(second)).connect() as stream:
                await collect(stream)
        task = asyncio.create_task(take())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert second.close_calls == 1

    asyncio.run(run())


def test_send_timeout_and_invalid_chunks():
    socket = FakeSocket()

    async def stalled_send(message):
        await asyncio.Event().wait()

    async def run():
        client = DeepgramStreamingClient("key", connector=FakeConnector(socket), send_timeout=0.01)
        async with client.connect() as stream:
            for chunk in (b"", "audio", None):
                with pytest.raises(ValueError, match="nonempty bytes"):
                    await stream.send_audio(chunk)
            socket.send = stalled_send
            with pytest.raises(DeepgramTimeoutError, match="send"):
                await stream.send_audio(b"audio")
            with pytest.raises(RuntimeError, match="no longer accepts"):
                await stream.send_audio(b"cannot retry this stream")
            with pytest.raises(DeepgramTimeoutError, match="send"):
                await stream.finish()
        assert socket.close_calls == 1

    asyncio.run(run())


def test_early_metadata_does_not_replace_terminal_metadata():
    socket = FakeSocket()
    socket.incoming.put_nowait(json.dumps({"type": "Metadata", "phase": "early"}))

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            reader = stream.events()
            assert await anext(reader) == {"type": "Metadata", "phase": "early"}
            receiver = asyncio.create_task(_consume_existing(reader))
            await stream.finish()
            assert await receiver == [{"type": "Metadata"}]

    async def _consume_existing(reader):
        return [event async for event in reader]

    asyncio.run(run())


def test_one_receiver_per_stream_and_independent_takes():
    sockets = []

    async def connector(*args, **kwargs):
        socket = FakeSocket()
        sockets.append(socket)
        return socket

    async def run():
        client = DeepgramStreamingClient("key", connector=connector)
        async with client.connect() as first, client.connect() as second:
            readers = [asyncio.create_task(collect(stream)) for stream in (first, second)]
            await asyncio.sleep(0)
            with pytest.raises(RuntimeError, match="only be read once"):
                await collect(first)
            await first.send_audio(b"first take")
            await second.send_audio(b"second take")
            await asyncio.gather(first.finish(), second.finish())
            await asyncio.gather(*readers)
        assert sockets[0].sent[0] == b"first take"
        assert sockets[1].sent[0] == b"second take"
        assert [socket.close_calls for socket in sockets] == [1, 1]

    asyncio.run(run())
