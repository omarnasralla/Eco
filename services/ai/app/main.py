"""
Eco AI service.

Two capabilities, deliberately kept in one small service:

  POST /forecast  — statistical cash-flow projection (numpy/statsmodels)
  POST /chat      — grounded natural-language answers (local LLM via Ollama)

They share a deployment because they share a dependency footprint and are
called by the same client on the same request path. They do not share a
failure mode: forecasting keeps working when the model is unavailable, which
is why readiness reports the LLM separately rather than failing on it.
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.logging_config import configure_logging, get_logger
from app.routers import chat, forecast, health

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info(
        "ai_service_starting",
        env=settings.eco_env,
        model=settings.eco_llm_model,
        ollama=settings.ollama_base_url,
    )
    yield
    logger.info("ai_service_stopping")


app = FastAPI(
    title="Eco AI Service",
    description="Financial forecasting and grounded LLM assistance for Eco.",
    version="0.1.0",
    lifespan=lifespan,
    # No public docs: this service is internal-only.
    docs_url="/docs" if get_settings().eco_env == "development" else None,
    redoc_url=None,
)

app.include_router(health.router, tags=["health"])
app.include_router(forecast.router, tags=["forecast"])
app.include_router(chat.router, tags=["chat"])


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never leak a traceback to the caller; log it in full instead."""
    logger.exception("unhandled_exception", path=request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal error occurred in the AI service."},
    )
