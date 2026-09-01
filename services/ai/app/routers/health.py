from fastapi import APIRouter

from app.config import get_settings
from app.models.schemas import HealthResponse
from app.services.llm import LLMService

router = APIRouter()
llm = LLMService()

VERSION = "0.1.0"


@router.get("/health/live")
async def live() -> dict[str, str]:
    """Liveness: is the process running? Checks nothing external by design."""
    return {"status": "ok"}


@router.get("/health/ready", response_model=HealthResponse)
async def ready() -> HealthResponse:
    """
    Readiness.

    Reports the LLM's availability but stays 'ok' without it: forecasting is
    pure numerics and keeps working when the model is down, so pulling this pod
    from the load balancer would take out a healthy capability along with the
    unhealthy one.
    """
    settings = get_settings()
    available = await llm.is_available()

    return HealthResponse(
        status="ok",
        llm_available=available,
        model=settings.eco_llm_model,
        version=VERSION,
    )
