"""
Forecasting tests.

The important cases are the degenerate ones — no history, one month, a series
that will not converge — because those are what a real new account looks like,
and a forecaster that throws or returns NaN there breaks the whole dashboard.
"""

import math

import pytest

from app.models.schemas import ForecastRequest, SeriesPoint
from app.services.forecasting import _add_months, generate_forecast


def series(values: list[int], start_year: int = 2024, start_month: int = 1) -> list[SeriesPoint]:
    points = []
    for i, value in enumerate(values):
        total = start_year * 12 + (start_month - 1) + i
        points.append(
            SeriesPoint(month=f"{total // 12:04d}-{total % 12 + 1:02d}", value_minor=value)
        )
    return points


def request_for(values: list[int], **kwargs) -> ForecastRequest:
    return ForecastRequest(
        user_id="00000000-0000-0000-0000-000000000000",
        currency="USD",
        horizon_months=kwargs.pop("horizon_months", 6),
        opening_balance_minor=kwargs.pop("opening_balance_minor", 1_000_000),
        monthly_income_minor=kwargs.pop("monthly_income_minor", 500_000),
        expense_history=series(values),
        **kwargs,
    )


class TestAddMonths:
    def test_crosses_year_boundaries(self):
        assert _add_months("2026-11", 3) == "2027-02"
        assert _add_months("2026-01", -1) == "2025-12"
        assert _add_months("2026-06", 0) == "2026-06"


class TestDegenerateInput:
    def test_no_history_returns_empty_with_a_warning(self):
        result = generate_forecast(request_for([]))
        assert result.points == []
        assert result.confidence == 0.0
        assert result.model == "none"
        assert "nothing to forecast" in result.warnings[0]

    def test_single_month_uses_the_mean_baseline(self):
        result = generate_forecast(request_for([400_000]))
        assert result.model == "mean-baseline"
        assert len(result.points) == 6
        assert all(p.projectedExpensesMinor == 400_000 for p in result.points)
        assert any("rough estimate" in w for w in result.warnings)

    def test_all_zero_history_does_not_divide_by_zero(self):
        result = generate_forecast(request_for([0] * 8))
        assert all(math.isfinite(p.projectedExpensesMinor) for p in result.points)
        assert all(p.projectedExpensesMinor >= 0 for p in result.points)

    def test_projections_are_never_negative(self):
        # A steep downward trend must clamp at zero, not project negative spend.
        result = generate_forecast(request_for([900_000, 700_000, 500_000, 300_000, 100_000]))
        assert all(p.projectedExpensesMinor >= 0 for p in result.points)


class TestModelSelection:
    def test_short_history_uses_a_damped_trend(self):
        result = generate_forecast(request_for([400_000, 410_000, 420_000, 430_000, 440_000, 450_000]))
        assert result.model in ("holt-damped-trend", "recent-mean-fallback")
        assert any("seasonal effects are not yet modelled" in w for w in result.warnings)

    def test_two_years_enables_the_seasonal_model(self):
        # A clear December spike repeated across two years.
        values = []
        for year in range(2):
            for month in range(1, 13):
                values.append(900_000 if month == 12 else 400_000)
        result = generate_forecast(request_for(values))
        assert result.model == "holt-winters-seasonal"
        assert not any("seasonal" in w for w in result.warnings)

    def test_seasonal_model_predicts_the_december_spike(self):
        values = []
        for year in range(2):
            for month in range(1, 13):
                values.append(900_000 if month == 12 else 400_000)
        # History ends at 2025-12, so a 12-month horizon reaches 2026-12.
        result = generate_forecast(request_for(values, horizon_months=12))
        december = next(p for p in result.points if p.month.endswith("-12"))
        others = [p for p in result.points if not p.month.endswith("-12")]
        assert december.projectedExpensesMinor > max(p.projectedExpensesMinor for p in others)


class TestCashFlow:
    def test_balance_compounds_month_over_month(self):
        result = generate_forecast(
            request_for([400_000] * 8, opening_balance_minor=1_000_000, monthly_income_minor=500_000)
        )
        balances = [p.projectedBalanceMinor for p in result.points]
        assert balances == sorted(balances)  # surplus, so it only grows
        assert result.points[0].projectedNetMinor == pytest.approx(100_000, abs=5_000)

    def test_flags_a_shortfall_when_expenses_outrun_income(self):
        result = generate_forecast(
            request_for([600_000] * 8, opening_balance_minor=100_000, monthly_income_minor=400_000)
        )
        assert any(p.isShortfall for p in result.points)
        assert result.points[-1].projectedBalanceMinor < 0

    def test_income_holds_flat_at_the_run_rate_by_default(self):
        result = generate_forecast(request_for([400_000] * 8, monthly_income_minor=525_000))
        assert all(p.projectedIncomeMinor == 525_000 for p in result.points)

    def test_income_history_is_modelled_when_supplied(self):
        request = request_for([400_000] * 8)
        request.income_history = series([500_000, 520_000, 540_000, 560_000, 580_000, 600_000])
        result = generate_forecast(request)
        # A rising income series should not be flattened to the run rate.
        assert result.points[0].projectedIncomeMinor > 560_000


class TestUncertainty:
    def test_intervals_widen_with_the_horizon(self):
        noisy = [300_000, 500_000, 350_000, 550_000, 320_000, 520_000, 340_000, 510_000]
        result = generate_forecast(request_for(noisy, horizon_months=6))
        spreads = [p.upperBoundMinor - p.lowerBoundMinor for p in result.points]
        assert spreads[-1] > spreads[0]

    def test_noisy_history_lowers_confidence_and_warns(self):
        steady = generate_forecast(request_for([400_000] * 12))
        noisy = generate_forecast(
            request_for([100_000, 900_000, 150_000, 850_000, 120_000, 880_000] * 2)
        )
        assert steady.confidence > noisy.confidence
        assert any("varies a lot" in w for w in noisy.warnings)

    def test_confidence_stays_within_bounds(self):
        for values in ([400_000], [0] * 5, [400_000] * 30, [1, 999_999] * 10):
            result = generate_forecast(request_for(values))
            assert 0.0 <= result.confidence <= 1.0
