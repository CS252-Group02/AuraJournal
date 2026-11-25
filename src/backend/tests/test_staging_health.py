from unittest.mock import Mock

from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.main import create_app
from test_api import application_for


def test_health_checks_existing_database_connection(migrated_engine):
    app = application_for(migrated_engine)
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"


def test_health_reports_database_outage_without_connection_details(monkeypatch):
    app = create_app()
    connect = Mock(side_effect=OperationalError("query", {}, RuntimeError("private connection details")))
    monkeypatch.setattr(app.state.engine, "connect", connect)
    try:
        response = TestClient(app).get("/api/health")
        assert response.status_code == 503
        assert "private connection details" not in response.text
        connect.assert_called_once()
    finally:
        app.state.engine.dispose()
