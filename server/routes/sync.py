"""Sync routes - relay playback events between partners and report drift."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import SyncPayload
from state import partner_of, state, utcnow

router = APIRouter(tags=["sync"], dependencies=[Depends(require_api_key)])

DRIFT_NOTIFY_THRESHOLD_S = 5


@router.post("/sync")
def sync_playback(payload: SyncPayload) -> dict[str, Any]:
    """Relay a sync event (play/pause/seek/speed/skip/tab) to the partner."""
    target = partner_of(payload.source_user)

    event: dict[str, Any] = {
        "command": payload.command,
        "seconds": payload.seconds,
        "source_user": payload.source_user,
    }
    if payload.playback_rate is not None:
        event["playback_rate"] = payload.playback_rate
    if payload.skip_type:
        event["skip_type"] = payload.skip_type

    print(f"[SYNC] {payload.source_user} -> {target}: {payload.command} @ {payload.seconds:.1f}s")
    bus.publish("command", event, target_user=target)

    return {"status": "ok", **event, "target_user": target}


@router.get("/sync/drift")
def check_drift(user: str) -> dict[str, Any]:
    """Estimate how far ahead the requesting user is versus their partner."""
    if not state.is_connected:
        return {"status": "not_connected", "drift": None}

    partner = partner_of(user)
    mine = state.playback.get(user)
    theirs = state.playback.get(partner)
    if not mine or not theirs:
        return {"status": "missing_data", "drift": None}
    if mine.get("watch_id") != theirs.get("watch_id"):
        return {"status": "different_video", "drift": None}
    if not mine.get("watch_id"):
        return {"status": "not_watching", "drift": None}

    now = utcnow()

    def estimated_position(playback: dict[str, Any]) -> float:
        elapsed = 0.0 if playback.get("paused") else (now - playback["server_time"]).total_seconds()
        return playback["position_s"] + elapsed

    my_pos = estimated_position(mine)
    their_pos = estimated_position(theirs)
    drift = my_pos - their_pos

    response = {
        "drift": round(drift, 1),
        "my_position": round(my_pos, 1),
        "their_position": round(their_pos, 1),
        "partner": partner,
        "my_paused": mine.get("paused", False),
        "their_paused": theirs.get("paused", False),
    }

    if drift > DRIFT_NOTIFY_THRESHOLD_S:
        response["status"] = "ahead"
        response["sync_to"] = int(their_pos)
    elif mine.get("paused") or theirs.get("paused"):
        response["status"] = "paused"
    else:
        response["status"] = "in_sync"
    return response
