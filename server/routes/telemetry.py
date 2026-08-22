"""Telemetry routes - playback state reporting and auto play/pause sync."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import TelemetryPayload
from state import partner_of, state, utcnow

router = APIRouter(tags=["telemetry"], dependencies=[Depends(require_api_key)])


def _watch_id_from_url(url: str) -> str | None:
    if "/watch/" not in url:
        return None
    return url.split("/watch/")[1].split("?")[0].split("/")[0]


def _auto_sync(user: str, new: dict[str, Any], old: dict[str, Any]) -> None:
    """If both users watch the same title and one changes play/pause state,
    mirror it to the partner automatically (server-side safety net)."""
    if not state.is_connected or not new.get("watch_id"):
        return

    partner = partner_of(user)
    partner_state = state.playback.get(partner, {})
    if partner_state.get("watch_id") != new.get("watch_id"):
        return

    command = None
    if new["paused"] and not partner_state.get("paused") and old.get("paused") is False:
        command = "sync_pause"
    elif not new["paused"] and partner_state.get("paused") and old.get("paused") is True:
        command = "sync_play"

    if command:
        bus.publish(
            "command",
            {
                "command": command,
                "seconds": int(new["position_s"]),
                "source_user": user,
                "origin": "auto",
            },
            target_user=partner,
        )
        print(f"[SYNC AUTO] {user} -> {partner}: {command} @ {int(new['position_s'])}s")


@router.post("/telemetry")
def receive_telemetry(payload: TelemetryPayload) -> dict[str, Any]:
    user = (payload.user or payload.id or "unknown").strip() or "unknown"
    now = utcnow()

    snapshot = payload.model_dump()
    snapshot["received_at"] = now.isoformat()
    state.telemetry[user] = snapshot

    old = state.playback.get(user, {})
    new = {
        "position_s": payload.position_s,
        "paused": payload.paused,
        "server_time": now,
        "url": payload.url,
        "watch_id": _watch_id_from_url(payload.url),
        "segment": payload.segment,
    }
    state.playback[user] = new

    _auto_sync(user, new, old)

    # Live feed for the dashboard.
    bus.publish(
        "telemetry",
        {
            "user": user,
            "url": payload.url,
            "watch_id": new["watch_id"],
            "position_s": payload.position_s,
            "duration_s": payload.duration_s,
            "paused": payload.paused,
            "rate": payload.rate,
            "frames": payload.frames,
            "dropped": payload.dropped,
            "action": payload.action,
            "segment": payload.segment,
            "timestamp": now.isoformat(),
        },
    )

    if payload.action:
        print(f"[TELEMETRY] {user}: action={payload.action}, pos={payload.position_s:.1f}s")

    return {"status": "received", "received_at": now.isoformat()}


@router.get("/telemetry/all")
def get_all_telemetry() -> dict[str, Any]:
    return {"status": "ok", "items": state.telemetry}
