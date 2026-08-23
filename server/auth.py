"""Authentication helpers.

Two auth mechanisms:

1. API key - accepted via the `X-API-Key` header or an `api_key` query
   parameter (EventSource cannot set headers, so streams use the query param).
2. Dashboard session - a signed, expiring token stored in a cookie after the
   dashboard password is entered. The cookie never contains the password.

`require_api_key` accepts either, so the dashboard's same-origin fetches work
with just the session cookie while the extension uses the API key.
"""

import hashlib
import hmac
import time

from fastapi import Header, HTTPException, Query, status
from starlette.requests import HTTPConnection

from config import settings

SESSION_COOKIE = "nc_dashboard_session"


def _key_matches(provided: str | None) -> bool:
    return provided is not None and hmac.compare_digest(str(provided), settings.api_key)


# ---------------------------------------------------------------------------
# Dashboard session tokens (HMAC-signed expiry, keyed off the API secret)
# ---------------------------------------------------------------------------

def _sign(expires_at: int) -> str:
    return hmac.new(
        settings.api_key.encode(), f"dashboard:{expires_at}".encode(), hashlib.sha256
    ).hexdigest()


def create_dashboard_token() -> tuple[str, int]:
    """Return (token, max_age_seconds) for a fresh dashboard session."""
    max_age = settings.dashboard_session_hours * 3600
    expires_at = int(time.time()) + max_age
    return f"{expires_at}.{_sign(expires_at)}", max_age


def verify_dashboard_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires_str, signature = token.split(".", 1)
    try:
        expires_at = int(expires_str)
    except ValueError:
        return False
    if expires_at < time.time():
        return False
    return hmac.compare_digest(signature, _sign(expires_at))


def has_dashboard_session(request: HTTPConnection) -> bool:
    return verify_dashboard_token(request.cookies.get(SESSION_COOKIE))


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def require_api_key(
    request: HTTPConnection,
    x_api_key: str | None = Header(None),
    api_key: str | None = Query(None),
) -> None:
    if _key_matches(x_api_key) or _key_matches(api_key):
        return
    if has_dashboard_session(request):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key"
    )
