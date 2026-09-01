"""
Time-series forecasting.

This is the production forecaster. The TypeScript implementation in
`packages/core/src/forecast.ts` is a deliberate, simpler fallback that the API
uses when this service is unreachable — the two agree closely on smooth series
and diverge only where the extra machinery here actually earns its keep
(seasonality with two or more years of history).

Model selection is driven by how much history exists, because fitting a
seasonal model to eight months of data produces confident nonsense:

  < 4 months    →  flat mean, wide interval, loud warning
  4–23 months   →  Holt's linear trend, damped
  >= 24 months  →  Holt-Winters with a 12-period seasonal component
"""

from __future__ import annotations

import warnings
from datetime import datetime, timezone

import numpy as np
from statsmodels.tsa.holtwinters import ExponentialSmoothing

from app.config import get_settings
from app.logging_config import get_logger
from app.models.schemas import (
    ForecastPoint,
    ForecastRequest,
    ForecastResponse,
    SeriesPoint,
)

logger = get_logger(__name__)


def _add_months(month: str, delta: int) -> str:
    year, mon = (int(part) for part in month.split("-"))
    total = year * 12 + (mon - 1) + delta
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _series_values(points: list[SeriesPoint]) -> tuple[list[str], np.ndarray]:
    ordered = sorted(points, key=lambda p: p.month)
    months = [p.month for p in ordered]
    values = np.array([float(p.value_minor) for p in ordered], dtype=float)
    return months, values


class ForecastResult:
    def __init__(self, values: np.ndarray, sigma: float, model: str) -> None:
        self.values = values
        self.sigma = sigma
        self.model = model


def _forecast_values(values: np.ndarray, horizon: int) -> ForecastResult:
    """Fits the most complex model the data actually supports."""
    settings = get_settings()
    n = len(values)

    if n == 0:
        return ForecastResult(np.zeros(horizon), 0.0, "empty")

    if n < settings.min_months_for_trend:
        # Too little history to infer a direction. The mean is the honest
        # answer; the interval carries the uncertainty.
        mean = float(np.mean(values))
        sigma = float(np.std(values, ddof=1)) if n > 1 else mean * 0.35
        return ForecastResult(np.full(horizon, mean), sigma, "mean-baseline")

    seasonal = n >= settings.min_months_for_seasonal

    try:
        with warnings.catch_warnings():
            # statsmodels is chatty about convergence on short series; we
            # handle a bad fit by falling back, so the warnings add nothing.
            warnings.simplefilter("ignore")
            model = ExponentialSmoothing(
                values,
                trend="add",
                # Damped trend: personal finance series are short, and an
                # undamped uptrend extrapolated twelve months out produces
                # numbers no user believes.
                damped_trend=True,
                seasonal="add" if seasonal else None,
                seasonal_periods=12 if seasonal else None,
                initialization_method="estimated",
            )
            fit = model.fit(optimized=True)
            forecast = np.asarray(fit.forecast(horizon), dtype=float)
            residuals = np.asarray(values, dtype=float) - np.asarray(fit.fittedvalues, dtype=float)
            sigma = float(np.std(residuals, ddof=1)) if len(residuals) > 1 else 0.0

        if not np.all(np.isfinite(forecast)):
            raise ValueError("model produced non-finite values")

        return ForecastResult(
            forecast,
            sigma,
            "holt-winters-seasonal" if seasonal else "holt-damped-trend",
        )

    except Exception as exc:  # noqa: BLE001 - any fit failure must degrade, not 500
        logger.warning("holt_winters_fit_failed", error=str(exc), n=n)
        # A recent-window mean is a defensible fallback: it tracks the current
        # level without pretending to know a trend we could not fit.
        recent = values[-6:]
        mean = float(np.mean(recent))
        sigma = float(np.std(recent, ddof=1)) if len(recent) > 1 else 0.0
        return ForecastResult(np.full(horizon, mean), sigma, "recent-mean-fallback")


def _confidence(values: np.ndarray, sigma: float) -> float:
    """Confidence falls with relative noise and rises with history length."""
    if len(values) == 0:
        return 0.0
    mean = float(np.mean(values))
    noise = (sigma / mean) if mean > 0 else 1.0
    history_score = min(len(values) / 24.0, 1.0)
    score = (1.0 - min(noise, 1.0)) * 0.7 + history_score * 0.3
    return round(max(0.0, min(1.0, score)), 2)


def generate_forecast(request: ForecastRequest) -> ForecastResponse:
    settings = get_settings()
    horizon = request.horizon_months
    warnings_out: list[str] = []

    months, expenses = _series_values(request.expense_history)
    if len(expenses) == 0:
        return ForecastResponse(
            generatedAt=datetime.now(timezone.utc).isoformat(),
            model="none",
            currency=request.currency,
            horizonMonths=horizon,
            confidence=0.0,
            points=[],
            warnings=["No spending history yet, so there is nothing to forecast from."],
        )

    last_month = months[-1]

    if len(expenses) < settings.min_months_for_trend:
        warnings_out.append(
            "Fewer than four months of history — this projection is a rough estimate."
        )
    elif len(expenses) < settings.min_months_for_seasonal:
        warnings_out.append(
            "Under two years of history, so seasonal effects are not yet modelled."
        )

    expense_result = _forecast_values(expenses, horizon)

    # Income: model it separately when real history exists, otherwise hold the
    # run rate flat. Modelling a flat series would only add spurious variance.
    if request.income_history:
        _, income_values = _series_values(request.income_history)
        income_result = _forecast_values(income_values, horizon)
    else:
        income_result = ForecastResult(
            np.full(horizon, float(request.monthly_income_minor)), 0.0, "flat-run-rate"
        )

    noise = float(np.std(expenses, ddof=1)) if len(expenses) > 1 else 0.0
    if float(np.mean(expenses)) > 0 and noise / float(np.mean(expenses)) > 0.4:
        warnings_out.append(
            "Your month-to-month spending varies a lot, so the range here is wide."
        )

    points: list[ForecastPoint] = []
    balance = float(request.opening_balance_minor)

    for h in range(horizon):
        month = _add_months(last_month, h + 1)
        projected_expenses = max(int(round(expense_result.values[h])), 0)
        projected_income = max(int(round(income_result.values[h])), 0)
        net = projected_income - projected_expenses
        balance += net

        # Uncertainty compounds with the square root of the horizon — the
        # standard random-walk assumption. Month 6 is ~2.4x as uncertain as
        # month 1, not 6x.
        spread = settings.forecast_confidence_z * np.sqrt(h + 1)
        expense_spread = int(round(expense_result.sigma * spread))
        income_spread = int(round(income_result.sigma * spread))

        worst_net = (projected_income - income_spread) - (projected_expenses + expense_spread)
        best_net = (projected_income + income_spread) - max(projected_expenses - expense_spread, 0)

        points.append(
            ForecastPoint(
                month=month,
                projectedIncomeMinor=projected_income,
                projectedExpensesMinor=projected_expenses,
                projectedNetMinor=net,
                projectedBalanceMinor=int(round(balance)),
                lowerBoundMinor=worst_net,
                upperBoundMinor=best_net,
                # Flagged on the pessimistic path, not the central estimate:
                # warning only once a shortfall is certain leaves no time to act.
                isShortfall=balance < 0 or (balance - net + worst_net) < 0,
            )
        )

    return ForecastResponse(
        generatedAt=datetime.now(timezone.utc).isoformat(),
        model=expense_result.model,
        currency=request.currency,
        horizonMonths=horizon,
        confidence=_confidence(expenses, expense_result.sigma),
        points=points,
        warnings=warnings_out,
    )
