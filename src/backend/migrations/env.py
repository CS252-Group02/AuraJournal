from pathlib import Path
import os

from alembic import context
from dotenv import load_dotenv

from app.config import database_url
from app.database import make_engine
from app.models import Base

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
target_metadata = Base.metadata


def run_migrations_online():
    # Tests can provide a connection with an isolated PostgreSQL search_path.
    connection = context.config.attributes.get("connection")
    if connection is not None:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return

    engine = make_engine(os.environ.get("MIGRATION_DATABASE_URL") or database_url())
    try:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=target_metadata)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


def run_migrations_offline():
    context.configure(
        url=os.environ.get("MIGRATION_DATABASE_URL") or database_url(), target_metadata=target_metadata,
        literal_binds=True, dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
