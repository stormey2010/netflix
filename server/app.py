"""Netflix Connect Server - application entry point.

FastAPI app that coordinates the watch-together experience between two users
by relaying telemetry, playback sync, commands, and navigation state over a
WebSocket-first unified event bus with SSE fallback.
"""

import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

# Allow absolute imports when running directly (python -m uvicorn app:app).
_server_dir = Path(__file__).parent
if str(_server_dir) not in sys.path:
    sys.path.insert(0, str(_server_dir))

from config import settings
from bus import bus
from routes import (
    commands_router,
    dashboard_router,
    events_router,
    invites_router,
    library_router,
    navigation_router,
    sync_router,
    telemetry_router,
)
from routes.tunnel import router as tunnel_router
from homeassistant import HomeAssistantBridge
from tunnel import TunnelManager

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

ALLOWED_ORIGINS = [
    "https://www.netflix.com",
    "https://netflix.com",
    "https://netflix-api.faredrop.xyz",
    "http://localhost:8767",
]
ALLOWED_ORIGIN_REGEX = (
    r"(https://([a-z0-9-]+\.)?netflix\.com)"
    r"|(chrome-extension://.+)"
    r"|(http://localhost:8767)"
    r"|(https://netflix-api\.faredrop\.xyz)"
)

# ---------------------------------------------------------------------------
# Lifespan - optional Cloudflare tunnel management
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.tunnel_manager = TunnelManager(
        token=settings.tunnel_token,
        config_path=settings.tunnel_config_path,
        tunnel_id=settings.tunnel_id,
        max_hours=settings.tunnel_max_hours,
    )
    app.state.home_assistant_bridge = HomeAssistantBridge(
        manager=app.state.tunnel_manager,
        base_url=settings.home_assistant_url,
        token=settings.home_assistant_token,
        entity_id=settings.home_assistant_entity_id,
    )
    await app.state.home_assistant_bridge.start()
    try:
        yield
    finally:
        await app.state.home_assistant_bridge.stop()
        await app.state.tunnel_manager.shutdown()


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(title="Netflix Connect API", version="1.1.0", lifespan=lifespan)


class EnsureCORSOnErrorsMiddleware(BaseHTTPMiddleware):
    """Guarantee CORS headers even on error/exception paths."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        origin = request.headers.get("origin")
        if origin and (
            origin in ALLOWED_ORIGINS or re.match(ALLOWED_ORIGIN_REGEX, origin)
        ):
            response.headers.setdefault("Access-Control-Allow-Origin", origin)
            response.headers.setdefault("Vary", "Origin")
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        return response


app.add_middleware(EnsureCORSOnErrorsMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
    expose_headers=["*"],
)

for router in (
    telemetry_router,
    sync_router,
    commands_router,
    navigation_router,
    invites_router,
    library_router,
    events_router,
    dashboard_router,
    tunnel_router,
):
    app.include_router(router)


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "netflix-connect",
        "realtime_clients": bus.subscriber_count(),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)
