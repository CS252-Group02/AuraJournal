from uuid import uuid4

import pytest

from app.services.image_storage import ImageStorage
from app.services.pixellab import PixelArtError
from test_pixellab import png


def test_private_persistence_and_no_overwrite(tmp_path):
    storage = ImageStorage(tmp_path / "private")
    entry_id, image_id = uuid4(), uuid4()
    key = storage.save(entry_id, image_id, png())
    assert storage.read(key) == png()
    assert not list(storage.root.rglob("*.tmp"))
    with pytest.raises(PixelArtError):
        storage.save(entry_id, image_id, b"overwrite")
    assert storage.read(key) == png()
    assert storage.delete(key)
    assert storage.read(key) is None


@pytest.mark.parametrize("key", ["../private.png", "/tmp/private.png", "https://example.test/a.png", "pixel-art/x/y.png"])
def test_reject_foreign_keys(tmp_path, key):
    storage = ImageStorage(tmp_path)
    assert storage.read(key) is None
    assert not storage.delete(key)
    with pytest.raises(ValueError):
        storage.path(key)


def test_symlinks_are_not_followed(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "private"
    root.mkdir()
    try:
        (root / "pixel-art").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Symlinks unavailable on this platform")
    storage = ImageStorage(root)
    with pytest.raises(PixelArtError):
        storage.save(uuid4(), uuid4(), png())
    assert not list(outside.iterdir())


def test_storage_failure_is_sanitized(tmp_path):
    root = tmp_path / "file"
    root.write_text("blocking file")
    with pytest.raises(PixelArtError) as caught:
        ImageStorage(root).save(uuid4(), uuid4(), png())
    assert str(root) not in caught.value.detail


def test_failed_write_leaves_no_temporary_file(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.image_storage.os.replace", lambda *args: (_ for _ in ()).throw(OSError("disk")))
    storage = ImageStorage(tmp_path)
    with pytest.raises(PixelArtError):
        storage.save(uuid4(), uuid4(), png())
    assert not list(tmp_path.rglob("*.tmp"))


def test_existing_temporary_file_is_never_deleted(tmp_path):
    storage = ImageStorage(tmp_path)
    entry_id, image_id = uuid4(), uuid4()
    temporary = storage.path(f"pixel-art/{entry_id}/{image_id}.png").with_suffix(".tmp")
    temporary.parent.mkdir(parents=True)
    temporary.write_bytes(b"another active writer")
    with pytest.raises(PixelArtError):
        storage.save(entry_id, image_id, png())
    assert temporary.read_bytes() == b"another active writer"
