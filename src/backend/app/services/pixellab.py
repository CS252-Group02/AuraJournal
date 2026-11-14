"""PixelLab v2 transport. One submission, no automatic billable retries."""
import base64
import binascii
from io import BytesIO
import time
import warnings
from struct import error as StructError

import httpx
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import pixellab_api_key

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class PixelArtError(RuntimeError):
    status_code = 503
    detail = "Pixel-art generation is unavailable. Please try again later."


class PixelArtInvalidResponse(PixelArtError):
    status_code = 502
    detail = "Image service returned an invalid response."


class PixelArtTimeout(PixelArtError):
    status_code = 504
    detail = "Image generation timed out; provider completion is uncertain. Check for an image before retrying."


class PixelArtRateLimited(PixelArtError):
    status_code = 429
    detail = "Image generation is busy. Please try again later."


class PixelArtCreditsUnavailable(PixelArtError):
    detail = "Image generation credits are unavailable. Please try again later."


class _Base64Image(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: str
    base64: str = Field(min_length=1, max_length=MAX_RESPONSE_BYTES)


class _ImageResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    image: _Base64Image


def decode_image(payload: bytes) -> bytes:
    try:
        envelope = _ImageResponse.model_validate_json(payload)
        if envelope.image.type != "base64":
            raise ValueError("Unsupported encoding")
        encoded = envelope.image.base64
        if encoded.startswith("data:"):
            prefix, encoded = encoded.split(",", 1)
            if prefix != "data:image/png;base64":
                raise ValueError("Unsupported media type")
        raw = base64.b64decode(encoded, validate=True)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as image:
                if image.format != "PNG" or image.size != (128, 128) or image.n_frames != 1:
                    raise ValueError("Unsupported image")
                image.verify()
            with Image.open(BytesIO(raw)) as image:
                image.load()
                clean = BytesIO()
                image.convert("RGBA").save(clean, format="PNG")
                return clean.getvalue()
    except (ValidationError, ValueError, TypeError, binascii.Error, OSError, SyntaxError, EOFError, StructError,
            UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise PixelArtInvalidResponse() from error


class PixelLabClient:
    def __init__(self, api_key: str | None = None, client: httpx.Client | None = None):
        self._api_key = pixellab_api_key() if api_key is None else api_key
        self._client = client

    def generate(self, prompt: str) -> bytes:
        if not self._api_key or not self._api_key.strip():
            raise PixelArtError()
        if not prompt.strip() or len(prompt) > 800:
            raise PixelArtInvalidResponse()
        client = self._client or httpx.Client(
            timeout=httpx.Timeout(120, connect=5, write=10, pool=5),
            follow_redirects=False,
        )
        deadline = time.monotonic() + 120
        try:
            with client.stream(
                "POST", "https://api.pixellab.ai/v2/create-image-pixen",
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"description": prompt, "image_size": {"width": 128, "height": 128},
                      "no_background": False, "enhance_prompt": False},
            ) as response:
                if response.status_code in {429, 529}:
                    raise PixelArtRateLimited()
                if response.status_code == 402:
                    raise PixelArtCreditsUnavailable()
                if response.status_code in {401, 403} or response.status_code >= 500:
                    raise PixelArtError()
                if response.status_code != 200:
                    raise PixelArtInvalidResponse()
                data = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        raise PixelArtTimeout()
                    if len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise PixelArtInvalidResponse()
                    data.extend(chunk)
            return decode_image(bytes(data))
        except httpx.TimeoutException as error:
            raise PixelArtTimeout() from error
        except httpx.HTTPError as error:
            raise PixelArtError() from error
        finally:
            if self._client is None:
                client.close()
