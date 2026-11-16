import base64
from io import BytesIO
import json

import httpx
from PIL import Image
import pytest

from app.services.pixellab import (
    MAX_RESPONSE_BYTES, PixelArtCreditsUnavailable, PixelArtError, PixelArtInvalidResponse,
    PixelArtRateLimited, PixelArtTimeout, PixelLabClient, decode_image,
)


def png(size=(128, 128), fmt="PNG"):
    output = BytesIO()
    Image.new("RGB", size, "pink").save(output, format=fmt)
    return output.getvalue()


def envelope(data=None, prefix=""):
    return {"image": {"type": "base64", "base64": prefix + base64.b64encode(data or png()).decode()}}


@pytest.mark.parametrize("prefix", ["", "data:image/png;base64,"])
def test_success_decodes_and_cleans_png(prefix):
    calls = []

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://api.pixellab.ai/v2/create-image-pixen"
        assert request.headers["authorization"] == "Bearer private-token"
        assert json.loads(request.content) == {
            "description": "A simple pixel art scene", "image_size": {"width": 128, "height": 128},
            "no_background": False, "enhance_prompt": False,
        }
        return httpx.Response(200, json=envelope(prefix=prefix))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        data = PixelLabClient(api_key="private-token", client=client).generate("A simple pixel art scene")
    with Image.open(BytesIO(data)) as image:
        assert image.size == (128, 128) and image.format == "PNG"
    assert len(calls) == 1


@pytest.mark.parametrize("payload", [
    b"not json", b"{}", b'{"image":{"type":"url","base64":"https://evil.test"}}',
    b'{"image":{"type":"base64","base64":"!!!"}}',
    json.dumps(envelope(b"not image")).encode(),
    json.dumps(envelope(png((64, 128)))).encode(),
    json.dumps(envelope(png(fmt="JPEG"))).encode(),
    json.dumps(envelope(prefix="data:image/jpeg;base64,")).encode(),
    json.dumps(envelope(png()[:70])).encode(),
])
def test_invalid_images_are_rejected(payload):
    with pytest.raises(PixelArtInvalidResponse):
        decode_image(payload)


@pytest.mark.parametrize("code,error", [
    (401, PixelArtError), (403, PixelArtError), (402, PixelArtCreditsUnavailable),
    (429, PixelArtRateLimited), (529, PixelArtRateLimited), (500, PixelArtError),
    (422, PixelArtInvalidResponse), (302, PixelArtInvalidResponse),
])
def test_provider_failures_are_sanitized_without_retries(code, error):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(code, text="secret provider error")

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(error) as caught:
            PixelLabClient(api_key="private-token", client=client).generate("scene")
    assert "secret" not in caught.value.detail
    assert len(calls) == 1


@pytest.mark.parametrize("error", [httpx.ReadTimeout, httpx.ConnectError])
def test_transport_failure(error):
    def handler(request):
        raise error("private detail", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PixelArtTimeout if error is httpx.ReadTimeout else PixelArtError):
            PixelLabClient(api_key="token", client=client).generate("scene")


def test_oversized_response_is_rejected():
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1)),
    )) as client:
        with pytest.raises(PixelArtInvalidResponse):
            PixelLabClient(api_key="token", client=client).generate("scene")


def test_missing_key_prevents_transport(monkeypatch):
    monkeypatch.delenv("PIXELLAB_API_KEY", raising=False)
    with pytest.raises(PixelArtError):
        PixelLabClient().generate("scene")
