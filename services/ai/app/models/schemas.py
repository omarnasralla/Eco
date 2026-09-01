"""
Request and response contracts.

These mirror the TypeScript types in @eco/shared. The API is the only client,
and it converts between the two naming conventions (snake_case here, camelCase
on the wire to browsers) at its own boundary.
"""

from typing import Literal

from pydantic import BaseModel, Field


class SeriesPoint(BaseModel):
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    value_minor: int


class ForecastRequest(BaseModel):
    user_id: str
    currency: str = Field(min_length=3, max_length=3)
    horizon_months: int = Field(default=6, ge=1, le=24)
    opening_balance_minor: int = 0
    monthly_income_minor: int = 0
    expense_history: list[SeriesPoint] = Field(default_factory=list)
    # Optional: when the caller has real per-month income (rather than a run
    # rate), pass it and both series are modelled independently.
    income_history: list[SeriesPoint] | None = None


class ForecastPoint(BaseModel):
    month: str
    projectedIncomeMinor: int
    projectedExpensesMinor: int
    projectedNetMinor: int
    projectedBalanceMinor: int
    lowerBoundMinor: int
    upperBoundMinor: int
    isShortfall: bool


class CategoryForecast(BaseModel):
    categoryId: str
    categoryName: str
    nextMonthMinor: int
    trend: Literal["RISING", "FALLING", "STABLE"]


class ForecastResponse(BaseModel):
    """Camel-cased to match ForecastDto so the API can pass it straight through."""

    generatedAt: str
    model: str
    currency: str
    horizonMonths: int
    confidence: float
    points: list[ForecastPoint]
    categoryForecasts: list[CategoryForecast] | None = None
    warnings: list[str] = Field(default_factory=list)


class SpendCategory(BaseModel):
    categoryId: str
    categoryName: str
    amountMinor: int
    historicalMedianMinor: int = 0
    isEssential: bool = False


class DebtSummary(BaseModel):
    id: str
    name: str
    currentBalanceMinor: int
    interestRateApr: float
    minimumPaymentMinor: int


class RecurringCharge(BaseModel):
    merchant: str
    averageAmountMinor: int
    frequency: str
    confidence: float


class ChatContext(BaseModel):
    """
    The pre-computed financial picture the model reasons over.

    Deliberately aggregated: the LLM never receives a raw transaction list. It
    keeps the prompt small, keeps inference fast, and means a prompt-injection
    payload sitting in a merchant name has nothing to reach for.
    """

    currency: str
    monthly_income_minor: int = 0
    monthly_expenses_minor: int = 0
    liquid_savings_minor: int = 0
    emergency_fund_target_minor: int = 0
    spend_by_category: list[SpendCategory] = Field(default_factory=list)
    debts: list[DebtSummary] = Field(default_factory=list)
    recurring: list[RecurringCharge] = Field(default_factory=list)
    forecast: list[ForecastPoint] = Field(default_factory=list)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    user_id: str
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list)
    context: ChatContext


class ChatResponse(BaseModel):
    content: str
    model: str
    tokens_used: int | None = None
    latency_ms: int | None = None
    suggestions: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    llm_available: bool
    model: str
    version: str
