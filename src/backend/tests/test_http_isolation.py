import asyncio

import httpx
import pytest


def test_sync_provider_http_fails_without_opening_a_connection():
    with httpx.Client() as client:
        with pytest.raises(pytest.fail.Exception, match="Real HTTP is forbidden"):
            client.get("https://api.groq.com/openai/v1/models")


def test_async_provider_http_fails_without_opening_a_connection():
    async def attempt():
        async with httpx.AsyncClient() as client:
            with pytest.raises(pytest.fail.Exception, match="Real HTTP is forbidden"):
                await client.get("https://api.deepgram.com/v1/listen")
    asyncio.run(attempt())


def test_mock_transports_remain_available():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"mocked": True}))
    with httpx.Client(transport=transport) as client:
        assert client.get("https://provider.example.test").json() == {"mocked": True}


def test_async_mock_transports_remain_available():
    async def attempt():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"mocked": True}))
        async with httpx.AsyncClient(transport=transport) as client:
            assert (await client.get("https://provider.example.test")).json() == {"mocked": True}
    asyncio.run(attempt())
