"""Telemetry routes - playback state observation and drift snapshots."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import TelemetryPayload
from state import state, utcnow

router = APIRouter(tags=["telemetry"], dependencies=[Depends(require_api_key)])


def _watch_id_from_url(url: str) -> str | None:
    if "/watch/" not in url:
        return None
    return url.split("/watch/")[1].split("?")[0].split("/")[0]


@router.post("/telemetry")
def receive_telemetry(payload: TelemetryPayload) -> dict[str, Any]:
    user = (payload.user or payload.id or "unknown").strip() or "unknown"
    now = utcnow()

    snapshot = payload.model_dump()
    snapshot["received_at"] = now.isoformat()
    state.telemetry[user] = snapshot

    new = {
        "position_s": payload.position_s,
        "paused": payload.paused,
        "server_time": now,
        "url": payload.url,
        "watch_id": _watch_id_from_url(payload.url),
        "segment": payload.segment,
    }
    state.playback[user] = new

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
