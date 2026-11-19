"""Migrate and seed an explicitly selected disposable development/test database."""
import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.orm import Session

from app.database import make_engine
from scripts.demo_calendar import calendar_report, seed_calendar_samples
import json


def setup(engine):
    config = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'head')
    with Session(engine) as session:
        with session.begin():
            seed_calendar_samples(session)
        return calendar_report(session)


def main():
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        raise SystemExit('Set TEST_DATABASE_URL to a disposable development/test database.')
    engine = make_engine(url)
    try:
        print(json.dumps(setup(engine), indent=2))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
