"""Fail closed on unsafe production settings; development remains localhost-friendly."""
import os
import secrets
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


def production() -> bool:
    mode = os.environ.get("APP_ENV", "development")
    if mode not in {"development", "test", "production"}:
        raise ValueError("APP_ENV must be development, test, or production.")
    return mode == "production"


def validate_settings(database_url: str, frontend_origin: str):
    if not production():
        return
    origin = urlsplit(frontend_origin)
    if (origin.scheme != "https" or not origin.hostname or origin.username or
            origin.password or origin.path or origin.query or origin.fragment):
        raise ValueError("Production FRONTEND_ORIGIN must be an HTTPS origin without a path.")
    if os.environ.get("AUTH_COOKIE_SECURE", "false").lower() != "true":
        raise ValueError("Production requires AUTH_COOKIE_SECURE=true.")
    url = make_url(database_url)
    if not url.username or not url.password or url.password in {"aurajournal", "postgres", "password"}:
        raise ValueError("Production requires explicit non-default database credentials.")
    if url.query.get("sslmode") != "verify-full":
        raise ValueError("Production DATABASE_URL must use sslmode=verify-full and a trusted CA.")


def database_posture(connection) -> dict:
    role = connection.execute(text(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication "
        "FROM pg_roles WHERE rolname=current_user"
    )).mappings().one()
    # pg_has_role also catches inherited or SET ROLE access to an owner.
    owns_tables = connection.scalar(text(
        "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') "
        "AND pg_has_role(current_user,c.relowner,'MEMBER'))"
    ))
    return {**role, "owns_tables": owns_tables,
            "role_memberships": connection.scalar(text(
                "SELECT EXISTS (SELECT 1 FROM pg_auth_members "
                "WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))")),
            "schema_create": connection.scalar(text("SELECT has_schema_privilege(current_schema(),'CREATE')")),
            "database_create": connection.scalar(text("SELECT has_database_privilege(current_database(),'CREATE')")),
            "tls": connection.scalar(text("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"))}


def validate_database(engine):
    with engine.connect() as connection:
        posture = database_posture(connection)
    if any(value for key, value in posture.items() if key != "tls") or not posture["tls"]:
        raise RuntimeError("Production requires a restricted, non-owner database role over TLS.")
    if not password_authentication_enforced(engine.url):
        raise RuntimeError("Could not verify database password authentication; check pg_hba.conf.")


def password_authentication_enforced(url) -> bool:
    """A network failure is not evidence of password enforcement.

    Production supports password-authenticated PostgreSQL. Probe once on startup
    with a random wrong password to detect trust/cert/peer bypass, without writes.
    """
    wrong = create_engine(make_url(url).set(password=secrets.token_urlsafe(32)),
                          connect_args={"connect_timeout": 5})
    try:
        with wrong.connect() as connection:
            connection.execute(text("SELECT 1"))
        return False
    except Exception as error:
        original = getattr(error, "orig", None)
        return (getattr(original, "sqlstate", None) == "28P01" or
                "password authentication failed" in str(original).lower())
    finally:
        wrong.dispose()
