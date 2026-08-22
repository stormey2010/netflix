"""Netflix Connect Server - application entry point.

FastAPI app that coordinates the watch-together experience between two users
by relaying telemetry, playback sync, commands, and navigation state over a
single unified SSE event bus.
"""

import re
import subprocess
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
# Lifespan - Cloudflare tunnel management
# ---------------------------------------------------------------------------

_cloudflared_proc: subprocess.Popen | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _cloudflared_proc
    bin_path = Path(settings.cloudflared_path)
    if not (_cloudflared_proc and _cloudflared_proc.poll() is None):
        try:
            cmd = [str(bin_path), "tunnel"]
            if settings.tunnel_config_path.exists():
                cmd += ["--config", str(settings.tunnel_config_path)]
            cmd += ["run", settings.tunnel_name]
            _cloudflared_proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            print(f"[TUNNEL] Started cloudflared tunnel '{settings.tunnel_name}'")
        except FileNotFoundError:
            print(f"[TUNNEL] cloudflared not found at {bin_path}; running local-only")
        except Exception as exc:
            print(f"[TUNNEL] Failed to start cloudflared: {exc}")

    try:
        yield
    finally:
        if _cloudflared_proc and _cloudflared_proc.poll() is None:
            try:
                _cloudflared_proc.terminate()
                _cloudflared_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _cloudflared_proc.kill()
            except Exception:
                pass
        _cloudflared_proc = None


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(title="Netflix Connect API", version="1.0.0", lifespan=lifespan)


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
):
    app.include_router(router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "netflix-connect"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)
