"""Measure owner/date lookups with synthetic rows; always roll back the data."""
import json
import os
from uuid import uuid4

from sqlalchemy import text

from app.database import make_engine


def benchmark(engine, rows=20000):
    owner = uuid4()
    with engine.connect() as connection, connection.begin() as transaction:
        connection.execute(text("INSERT INTO users (id, email, password_hash) VALUES (:owner, :email, '!disabled')"),
                           {'owner': owner, 'email': f'benchmark-{owner}@example.test'})
        connection.execute(text("""
            INSERT INTO journal_entries (id, user_id, content, journal_date)
            SELECT md5(CAST(:owner AS text) || '/' || i)::uuid, :owner,
                   'Synthetic benchmark', DATE '2020-01-01' + (i % 2000)
            FROM generate_series(1, :rows) AS i
        """), {'owner': owner, 'rows': rows})
        connection.execute(text('ANALYZE journal_entries'))
        queries = {
            'day_lookup': "SELECT id FROM journal_entries WHERE user_id=:owner AND journal_date=DATE '2020-02-01' ORDER BY journal_date DESC, created_at DESC, id DESC",
            'month_counts': "SELECT journal_date,count(*) FROM journal_entries WHERE user_id=:owner AND journal_date BETWEEN DATE '2020-02-01' AND DATE '2020-02-29' GROUP BY journal_date ORDER BY journal_date",
        }
        plans = {name: connection.scalar(text('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query),
                                         {'owner': owner}) for name, query in queries.items()}
        transaction.rollback()
    return {'synthetic_rows': rows, 'plans': plans}


def main():
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        raise SystemExit('Set TEST_DATABASE_URL to a disposable database migrated to head.')
    engine = make_engine(url)
    try:
        print(json.dumps(benchmark(engine), indent=2))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
