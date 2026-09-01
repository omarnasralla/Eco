from fastapi import APIRouter, Depends, HTTPException, status

from app.logging_config import get_logger
from app.models.schemas import ChatRequest, ChatResponse
from app.security import require_service_token
from app.services.llm import LLMService, LLMUnavailableError

logger = get_logger(__name__)

router = APIRouter(dependencies=[Depends(require_service_token)])
llm = LLMService()


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """Answers a question grounded in the caller-supplied financial snapshot."""
    try:
        return await llm.chat(request)
    except LLMUnavailableError as exc:
        # 503 rather than 500: the API treats this as "degrade and tell the
        # user to retry", not as a bug to alert on.
        logger.warning("chat_unavailable", user_id=request.user_id, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The language model is unavailable.",
        ) from exc
