from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from app.config import database_url as configured_database_url, frontend_origin
from app.database import make_engine
from app.routers.entries import router as entries_router
from app.routers.auth import router as auth_router
from app.routers.summaries import router as summaries_router
from app.routers.titles import router as titles_router
from app.services import JournalSummarizer, JournalTitleGenerator
from app.auth import require_browser_request
from app.deployment import production, validate_settings, validate_database
from app.request_limits import RequestSizeLimit


def create_app(database_url: str | None = None) -> FastAPI:
    url = database_url or configured_database_url()
    validate_settings(url, frontend_origin())
    engine = make_engine(url)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            if production():
                validate_database(engine)
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="AuraJournal API", lifespan=lifespan, dependencies=[Depends(require_browser_request)])
    app.state.engine = engine
    app.state.session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    app.state.journal_summarizer = JournalSummarizer()
    app.state.journal_title_generator = JournalTitleGenerator()

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if production():
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response
    app.add_middleware(RequestSizeLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[frontend_origin()],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-AuraJournal-CSRF"],
    )

    @app.exception_handler(SQLAlchemyError)
    async def database_error_handler(_, __):
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Database is unavailable. Please try again later."},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_, error):
        # Pydantic's default details include submitted input, including passwords.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
            for item in error.errors()
        ]})

    app.include_router(entries_router)
    app.include_router(summaries_router)
    app.include_router(titles_router)
    app.include_router(auth_router)
    return app


app = create_app()
