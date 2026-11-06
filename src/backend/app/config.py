import os
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
