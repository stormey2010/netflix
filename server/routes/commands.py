"""Command routes - explicit playback commands from the dashboard or shares."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import CommandPayload
from state import partner_of

router = APIRouter(tags=["commands"], dependencies=[Depends(require_api_key)])


@router.post("/command")
def send_command(payload: CommandPayload) -> dict[str, Any]:
    cmd = {k: v for k, v in payload.model_dump().items() if v is not None}
    target = payload.target_user

    # Shares always go to the other user.
    if payload.command == "share" and payload.source_user:
        target = partner_of(payload.source_user)
        print(f"[COMMAND] share '{payload.title}' -> {target} ({payload.url})")
    else:
        print(
            f"[COMMAND] {payload.command} -> {target or 'all'}"
            + (f" @ {payload.seconds}s" if payload.seconds is not None else "")
        )

    cmd.pop("target_user", None)
    bus.publish("command", cmd, target_user=target)
    return {"status": "ok", "command": payload.command, "target_user": target}
