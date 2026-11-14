"""Run hourly and after restarts against the same DB and volume as the backend."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend"))

from dotenv import load_dotenv
from sqlalchemy.exc import SQLAlchemyError

from app.config import database_url, journal_image_storage_dir
from app.database import make_engine
from app.services.image_lifecycle import reconcile_images
from app.services.image_storage import ImageStorage
from app.services.pixellab import PixelArtError


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    engine = make_engine(database_url())
    try:
        count = reconcile_images(engine, ImageStorage(journal_image_storage_dir()))
        print(f"Removed {count} unreferenced image files.")
    except (PixelArtError, SQLAlchemyError):
        sys.exit("Image cleanup failed; check database and private storage availability.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
