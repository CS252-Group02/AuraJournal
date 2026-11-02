# %%
from __future__ import annotations

from pathlib import Path

import PIL.Image
import requests

import pixellab
from pixellab.models import Base64Image, ImageSize

raise NotImplementedError

API_KEY =


def test_generate_image_bitforge():
    client = pixellab.Client(secret=API_KEY)

    images_dir = Path("tests") / "images"
    # inpainting_image = PIL.Image.open(images_dir / "boy.png")
    # style_image = PIL.Image.open(images_dir / "boy.png")
    # mask_image = PIL.Image.open(images_dir / "mask.png")
    # init_image = PIL.Image.open(images_dir / "boy.png")

    # The SDK requires usage in USD, but the API also returns generation counts.
    # Parse the image directly so either billing format works without retrying.
    response = requests.post(
        f"{client.base_url}/generate-image-bitforge",
        headers=client.headers(),
        json={
            "description": "1-bit pixel art style high school student standing confidently in front of a modern school building. Clear sunny day, soft golden hour sunlight, lush green lawn, warm welcoming atmosphere, shallow depth of field.",
            "image_size": ImageSize(width=128, height=64),
            "no_background": True,
            "init_image_strength": 250,
        },
        timeout=180,
    )
    response.raise_for_status()

    # Verify we got a valid image back
    image = Base64Image.model_validate(response.json()["image"]).pil_image()
    assert isinstance(image, PIL.Image.Image)
    assert image.size == (128, 64)

    # Create results directory using pathlib
    results_dir = Path(__file__).resolve().parent / "tests" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)

    # Save the generated image using pathlib
    image.save(results_dir / "tinh dau buoi.png")
    print(f"Saved image to {results_dir / 'tinh dau buoi.png'}")


if __name__ == "__main__":
    test_generate_image_bitforge()
