from fastapi import APIRouter, Depends

from app.logging_config import get_logger
from app.models.schemas import ForecastRequest, ForecastResponse
from app.security import require_service_token
from app.services.forecasting import generate_forecast

logger = get_logger(__name__)

router = APIRouter(dependencies=[Depends(require_service_token)])


@router.post("/forecast", response_model=ForecastResponse)
async def forecast(request: ForecastRequest) -> ForecastResponse:
    """Cash-flow projection with prediction intervals."""
    result = generate_forecast(request)
    logger.info(
        "forecast_generated",
        user_id=request.user_id,
        model=result.model,
        horizon=request.horizon_months,
        history_months=len(request.expense_history),
        confidence=result.confidence,
    )
    return result
