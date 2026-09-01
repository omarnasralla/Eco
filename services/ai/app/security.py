"""Service-to-service authentication."""

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_service_token(authorization: str = Header(default="")) -> None:
    """
    Verifies the shared secret from the API.

    This service is never exposed publicly — it sits on the internal network and
    only ever answers the NestJS API, which has already authenticated the user
    and scoped the data in the request body. The token exists so that a
    compromised pod elsewhere in the cluster cannot query it directly.

    Compared with `hmac.compare_digest` so the check leaks nothing through
    timing.
    """
    settings = get_settings()
    expected = f"Bearer {settings.ai_service_token}"

    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing service token",
        )
