import os
from pathlib import Path
from uuid import UUID

# Owner of the temporary unauthenticated journal flow; also seeded by migration 0002.
DEVELOPMENT_USER_ID = UUID("00000000-0000-4000-8000-000000000001")


def database_url() -> str:
    return os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal",
    )


def frontend_origin() -> str:
    return os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")


def groq_api_key() -> str | None:
    return os.environ.get("GROQ_API_KEY")


def groq_model() -> str:
    return os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")


def deepgram_api_key() -> str | None:
    return os.environ.get("DEEPGRAM_API_KEY")


def pixellab_enabled() -> bool:
    return os.environ.get("PIXELLAB_ENABLED", "false").lower() == "true"


def pixellab_api_key() -> str | None:
    return os.environ.get("PIXELLAB_API_KEY")


def journal_image_storage_dir() -> Path:
    default = Path(__file__).resolve().parents[3] / "var" / "journal-images"
    return Path(os.environ.get("JOURNAL_IMAGE_STORAGE_DIR", "").strip() or default)


def pixel_worker_enabled() -> bool:
    return os.environ.get("PIXEL_ART_WORKER_ENABLED", "true").lower() == "true"


def pixel_worker_concurrency() -> int:
    # This is also the shared PostgreSQL slot count; use the same value on all replicas.
    return max(1, min(4, int(os.environ.get("PIXEL_ART_CONCURRENCY", "2"))))


def pixel_submission_budgets(user_id) -> list[tuple[str, int, int]]:
    return [
        (f"pixel:user:minute:{user_id}", 10, 60),
        (f"pixel:user:day:{user_id}", max(1, int(os.environ.get("PIXEL_ART_USER_DAILY_LIMIT", "20"))), 86400),
        ("pixel:global:day", max(1, int(os.environ.get("PIXEL_ART_DAILY_LIMIT", "200"))), 86400),
    ]
