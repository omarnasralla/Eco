"""Service configuration, read from the environment."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    eco_env: str = "development"
    log_level: str = "INFO"

    # Shared secret with the NestJS API. This service is never exposed to the
    # public internet; it only ever answers the API, which has already
    # authenticated the user and scoped the data it passes in.
    ai_service_token: str = "replace_me_shared_service_token"

    redis_url: str = "redis://localhost:6379"

    # ── LLM ──────────────────────────────────────────────────────────────
    ollama_base_url: str = "http://localhost:11434"
    # Any small local model works. Defaults to Llama 3.2 3B: fast enough on CPU,
    # good enough at grounded summarisation, and small enough to self-host —
    # which is the point. Financial data never leaves the deployment.
    eco_llm_model: str = "llama3.2:3b"
    eco_llm_temperature: float = 0.2
    eco_llm_timeout_seconds: int = 60
    eco_llm_max_tokens: int = 800

    # ── Forecasting ──────────────────────────────────────────────────────
    # Holt-Winters needs two full cycles to fit a seasonal component.
    min_months_for_seasonal: int = 24
    min_months_for_trend: int = 4
    forecast_confidence_z: float = 1.2816  # 80% prediction interval


@lru_cache
def get_settings() -> Settings:
    return Settings()
