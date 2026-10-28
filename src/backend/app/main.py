import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, Integer, String, create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    content: Mapped[str] = mapped_column(String(5000), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class EntryCreate(BaseModel):
    content: str = Field(min_length=1, max_length=5000)


class EntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    content: str
    created_at: datetime


def create_app(database_url: str | None = None) -> FastAPI:
    url = database_url or os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal",
    )
    engine_options = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        engine_options["connect_args"] = {"check_same_thread": False}
        if url in {"sqlite://", "sqlite:///:memory:"}:
            engine_options["poolclass"] = StaticPool
    engine = create_engine(url, **engine_options)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        Base.metadata.create_all(engine)
        yield
        engine.dispose()

    app = FastAPI(title="AuraJournal PoC API", lifespan=lifespan)
    app.state.engine = engine
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    async def get_session() -> AsyncGenerator[Session, None]:
        with session_factory() as session:
            yield session

    @app.exception_handler(SQLAlchemyError)
    async def database_error_handler(_, __):
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Database is unavailable. Please try again later."},
        )

    @app.get("/api/health")
    async def health(session: Session = Depends(get_session)):
        session.execute(select(1))
        return {"status": "ok", "database": "connected"}

    @app.post("/api/entries", response_model=EntryResponse, status_code=201)
    async def create_entry(payload: EntryCreate, session: Session = Depends(get_session)):
        entry = JournalEntry(content=payload.content.strip())
        if not entry.content:
            raise HTTPException(status_code=422, detail="Entry content cannot be blank.")
        session.add(entry)
        session.commit()
        session.refresh(entry)
        return entry

    @app.get("/api/entries", response_model=list[EntryResponse])
    async def list_entries(session: Session = Depends(get_session)):
        return list(session.scalars(select(JournalEntry).order_by(JournalEntry.id.desc())))

    return app


app = create_app()
