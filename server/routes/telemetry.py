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


def _service_from_url(url: str) -> str:
    host = (url or "").split("/", 3)[2].lower() if "://" in (url or "") else ""
    host = host.removeprefix("www.")
    names = {
        "netflix.com": "netflix",
        "youtube.com": "youtube",
        "youtu.be": "youtube",
        "primevideo.com": "prime",
        "hulu.com": "hulu",
        "peacocktv.com": "peacock",
        "disneyplus.com": "disney",
    }
    return names.get(host, "unknown")


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
        "watch_id": payload.media_id or _watch_id_from_url(payload.url),
        "media_id": payload.media_id or _watch_id_from_url(payload.url),
        "service": payload.service or _service_from_url(payload.url),
        "service_name": payload.service_name or payload.service or _service_from_url(payload.url),
        "title": payload.title,
        "context": payload.context or {"kind": "content", "blocking": False},
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
            "media_id": new["media_id"],
            "service": new["service"],
            "service_name": new["service_name"],
            "title": new["title"],
            "context": new["context"],
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
