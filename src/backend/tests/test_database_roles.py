"""Optional administrator test; provisioning is rolled back in a scratch DB.

Never point SECURITY_ADMIN_DATABASE_URL at a production cluster. Tests create
one uniquely named database and require the two deployment role names to be free.
"""
import os
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from app.deployment import database_posture


def test_runtime_role_script_is_repeatable_and_restricts_ddl():
    url = os.environ.get("SECURITY_ADMIN_DATABASE_URL")
    if not url:
        pytest.skip("Explicit disposable-cluster admin URL required for role provisioning test")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "security_role_test_" + uuid4().hex
    with admin.connect() as c:
        if c.scalar(text("SELECT count(*) FROM pg_roles WHERE rolname IN ('aurajournal_owner','aurajournal_runtime')")):
            pytest.skip("Deployment roles already exist; leave them untouched")
        c.exec_driver_sql(f'CREATE DATABASE "{name}"')
    engine = create_engine(admin.url.set(database=name), isolation_level="READ COMMITTED")
    try:
        with engine.connect() as c:
            transaction = c.begin()
            try:
                from alembic import command
                from alembic.config import Config
                config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
                config.attributes["connection"] = c
                command.upgrade(config, "head")
                script = (Path(__file__).resolve().parents[3] / "scripts/database-runtime-role.sql").read_text()
                script = "\n".join(line for line in script.splitlines()
                                   if not line.startswith("\\") and line not in {"BEGIN;", "COMMIT;"})
                script = script.replace(':"DBNAME"', f'"{name}"')
                c.execute(text(script))
                c.execute(text(script))
                c.exec_driver_sql("SET LOCAL ROLE aurajournal_runtime")
                posture = database_posture(c)
                assert not any(v for k, v in posture.items() if k != "tls")
                c.exec_driver_sql("INSERT INTO users (id,email,password_hash) VALUES (gen_random_uuid(),'role@example.com','!disabled')")
                assert c.scalar(text("SELECT count(*) FROM users WHERE email='role@example.com'")) == 1
                c.exec_driver_sql("DELETE FROM users WHERE email='role@example.com'")
                for sql in ["CREATE TABLE public.forbidden(id integer)",
                            "ALTER TABLE users ADD COLUMN forbidden text", "DROP TABLE users CASCADE",
                            "UPDATE alembic_version SET version_num='bad'"]:
                    savepoint = c.begin_nested()
                    with pytest.raises(DBAPIError):
                        c.exec_driver_sql(sql)
                    savepoint.rollback()
                c.exec_driver_sql("RESET ROLE")
                c.exec_driver_sql("SET LOCAL ROLE aurajournal_owner")
                c.exec_driver_sql("CREATE TABLE public.owner_can_migrate(id integer)")
            finally:
                transaction.rollback()
    finally:
        engine.dispose()
        with admin.connect() as c:
            c.exec_driver_sql(f'DROP DATABASE "{name}"')
        admin.dispose()
