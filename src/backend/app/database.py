from collections.abc import Generator

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session


def make_engine(url: str):
    if make_url(url).get_backend_name() != "postgresql":
        raise ValueError("AuraJournal requires a PostgreSQL DATABASE_URL.")
    return create_engine(url, pool_pre_ping=True)


def get_session(request: Request) -> Generator[Session, None, None]:
    with request.app.state.session_factory() as session:
        yield session
