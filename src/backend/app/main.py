from contextlib import asynccontextmanager

from fastapi import FastAPI, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from app.config import database_url as configured_database_url, frontend_origin
from app.database import make_engine
from app.routers.entries import router as entries_router


def create_app(database_url: str | None = None) -> FastAPI:
    engine = make_engine(database_url or configured_database_url())

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="AuraJournal API", lifespan=lifespan)
    app.state.engine = engine
    app.state.session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[frontend_origin()],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(SQLAlchemyError)
    async def database_error_handler(_, __):
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Database is unavailable. Please try again later."},
        )

    app.include_router(entries_router)
    return app


app = create_app()
