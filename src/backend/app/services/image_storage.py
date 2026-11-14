"""Private application-owned files; never a static/public directory."""
from pathlib import Path
import os
import re
from uuid import UUID

from app.services.pixellab import PixelArtError

KEY = re.compile(r"pixel-art/([0-9a-f-]{36})/([0-9a-f-]{36})\.png\Z")


class ImageStorage:
    def __init__(self, root: Path):
        self.root = root.absolute()

    def path(self, key: str) -> Path:
        match = KEY.fullmatch(key)
        if match is None:
            raise ValueError("Not an application-owned image key.")
        UUID(match[1])
        UUID(match[2])
        path = self.root / key
        # A trusted administrator configures root; reject symlinks below it.
        for component in (self.root, path.parent.parent, path.parent, path):
            if component.is_symlink():
                raise ValueError("Invalid image storage path.")
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError("Invalid image storage path.")
        return path

    def save(self, entry_id: UUID, image_id: UUID, data: bytes) -> str:
        key = f"pixel-art/{entry_id}/{image_id}.png"
        try:
            path = self.path(key)
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.parent.parent.mkdir(exist_ok=True, mode=0o700)
            path.parent.mkdir(exist_ok=True, mode=0o700)
            if path.exists():
                raise OSError("Image already exists")
            temporary = path.with_suffix(".tmp")
            created_temporary = False
            try:
                with temporary.open("xb") as output:
                    created_temporary = True
                    os.chmod(temporary, 0o600)
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                if created_temporary:
                    temporary.unlink(missing_ok=True)
            return key
        except (OSError, ValueError) as error:
            raise PixelArtError() from error

    def read(self, key: str) -> bytes | None:
        try:
            path = self.path(key)
            if not path.exists():
                return None
            with path.open("rb") as source:
                data = source.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise OSError("Invalid stored image")
            return data
        except ValueError:
            return None
        except OSError as error:
            raise PixelArtError() from error

    def delete(self, key: str) -> bool:
        try:
            self.path(key).unlink(missing_ok=True)
            return True
        except (ValueError, OSError):
            # Never follow legacy/external keys. Reconciliation retries owned files.
            return False
