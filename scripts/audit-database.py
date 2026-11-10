"""Read-only role/TLS audit plus one deliberately wrong-password connection.

Run with the backend virtualenv. Does not print credentials or journal data.
Exit 1 means unsafe for production; connection errors alone are not a pass.
"""
import json
import os
from pathlib import Path
import sys

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/backend"))
from app.deployment import database_posture, password_authentication_enforced


def main():
    load_dotenv(ROOT / ".env")
    url = make_url(os.environ["DATABASE_URL"])
    engine = create_engine(url, connect_args={"connect_timeout": 5})
    try:
        with engine.connect() as connection:
            result = database_posture(connection)
    finally:
        engine.dispose()
    result["password_rejected"] = password_authentication_enforced(url)
    print(json.dumps(result, indent=2))
    return int(not result["tls"] or not result["password_rejected"] or any(
        value for key, value in result.items() if key not in {"tls", "password_rejected"}
    ))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit("Audit could not complete; check configuration and database availability. Details omitted.")
