"""Authenticated control surface for the optional Cloudflare Tunnel."""

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from auth import require_api_key
from config import settings
from tunnel import TunnelManager

router = APIRouter(
    prefix="/control/tunnel",
    tags=["tunnel"],
    dependencies=[Depends(require_api_key)],
)


class TunnelCommand(BaseModel):
    enabled: bool


def _require_control_token(request: Request) -> None:
    expected = settings.tunnel_control_token
    supplied = request.headers.get("X-Tunnel-Control-Token")
    if not expected or not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid tunnel control token",
        )


def manager(request: Request) -> TunnelManager:
    return request.app.state.tunnel_manager


@router.get("")
async def tunnel_status(request: Request):
    _require_control_token(request)
    return await manager(request).status()


@router.post("")
async def tunnel_command(request: Request, command: TunnelCommand):
    _require_control_token(request)
    try:
        if command.enabled:
            return await manager(request).enable()
        return await manager(request).disable()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
