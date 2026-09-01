"""End-to-end tests through the HTTP layer, including service authentication."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

client = TestClient(app)
TOKEN = get_settings().ai_service_token
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def forecast_body(**kwargs) -> dict:
    body = {
        "user_id": "00000000-0000-0000-0000-000000000000",
        "currency": "GBP",
        "horizon_months": 6,
        "opening_balance_minor": 1_000_000,
        "monthly_income_minor": 464_000,
        "expense_history": [
            {"month": f"2025-{m:02d}", "value_minor": 300_000 + m * 1_000}
            for m in range(1, 13)
        ],
    }
    body.update(kwargs)
    return body


class TestHealth:
    def test_liveness_needs_no_token(self):
        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_readiness_reports_llm_availability_without_failing_on_it(self):
        response = client.get("/health/ready")
        assert response.status_code == 200
        body = response.json()
        # Forecasting works without the model, so readiness stays ok either way.
        assert body["status"] == "ok"
        assert isinstance(body["llm_available"], bool)


class TestServiceAuth:
    def test_rejects_a_missing_token(self):
        assert client.post("/forecast", json=forecast_body()).status_code == 401

    def test_rejects_a_wrong_token(self):
        response = client.post(
            "/forecast", json=forecast_body(), headers={"Authorization": "Bearer nope"}
        )
        assert response.status_code == 401

    def test_rejects_a_token_without_the_bearer_scheme(self):
        response = client.post(
            "/forecast", json=forecast_body(), headers={"Authorization": TOKEN}
        )
        assert response.status_code == 401

    def test_accepts_the_configured_token(self):
        assert client.post("/forecast", json=forecast_body(), headers=AUTH).status_code == 200


class TestForecastEndpoint:
    def test_returns_the_requested_horizon(self):
        response = client.post("/forecast", json=forecast_body(horizon_months=9), headers=AUTH)
        body = response.json()
        assert len(body["points"]) == 9
        assert body["currency"] == "GBP"
        assert body["horizonMonths"] == 9

    def test_months_run_consecutively_from_the_end_of_history(self):
        body = client.post("/forecast", json=forecast_body(), headers=AUTH).json()
        assert [p["month"] for p in body["points"]] == [
            "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
        ]

    def test_rejects_an_out_of_range_horizon(self):
        assert client.post(
            "/forecast", json=forecast_body(horizon_months=99), headers=AUTH
        ).status_code == 422
        assert client.post(
            "/forecast", json=forecast_body(horizon_months=0), headers=AUTH
        ).status_code == 422

    def test_rejects_a_malformed_month(self):
        assert client.post(
            "/forecast",
            json=forecast_body(expense_history=[{"month": "2025-13", "value_minor": 1}]),
            headers=AUTH,
        ).status_code == 422

    def test_handles_an_empty_history_gracefully(self):
        response = client.post("/forecast", json=forecast_body(expense_history=[]), headers=AUTH)
        assert response.status_code == 200
        assert response.json()["points"] == []


class TestChatEndpoint:
    def test_reports_503_when_the_model_is_unreachable(self):
        # No Ollama in the test environment. The API relies on 503 (not 500) to
        # decide this is a degradation to surface, not a bug to alert on.
        response = client.post(
            "/chat",
            json={
                "user_id": "00000000-0000-0000-0000-000000000000",
                "message": "How much did I spend on food?",
                "history": [],
                "context": {"currency": "GBP"},
            },
            headers=AUTH,
        )
        assert response.status_code == 503

    def test_rejects_an_empty_message(self):
        response = client.post(
            "/chat",
            json={
                "user_id": "00000000-0000-0000-0000-000000000000",
                "message": "",
                "history": [],
                "context": {"currency": "GBP"},
            },
            headers=AUTH,
        )
        assert response.status_code == 422
