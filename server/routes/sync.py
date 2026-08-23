"""Sync routes - relay playback events between partners and report/align drift."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from config import settings
from schemas import SyncPayload
from state import partner_of, state, utcnow

router = APIRouter(tags=["sync"], dependencies=[Depends(require_api_key)])

DRIFT_NOTIFY_THRESHOLD_S = 5
SOFT_SYNC_MAX_S = 10


def _estimated_position(playback: dict[str, Any], now) -> float:
    elapsed = 0.0 if playback.get("paused") else (now - playback["server_time"]).total_seconds()
    return playback["position_s"] + elapsed


@router.post("/sync")
def sync_playback(payload: SyncPayload) -> dict[str, Any]:
    """Relay a sync event (play/pause/seek/speed/skip/segment/tab) to the partner."""
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
    if payload.segment:
        event["segment"] = payload.segment
    if payload.soft is not None:
        event["soft"] = payload.soft
    for key in ("paused", "rate", "event_id", "stream_id", "seq", "client_sent_ms"):
        value = getattr(payload, key)
        if value is not None:
            event[key] = value
    event["server_received_ms"] = utcnow().timestamp() * 1000
    event["transport"] = "http"

    print(f"[SYNC] {payload.source_user} -> {target}: {payload.command} @ {payload.seconds:.1f}s")
    bus.publish("command", event, target_user=target)

    return {"status": "ok", **event, "target_user": target}


@router.get("/sync/drift")
def check_drift(user: str) -> dict[str, Any]:
    """Estimate how far ahead/behind the requesting user is versus their partner."""
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
    my_pos = _estimated_position(mine, now)
    their_pos = _estimated_position(theirs, now)
    drift = my_pos - their_pos

    response = {
        "drift": round(drift, 1),
        "my_position": round(my_pos, 1),
        "their_position": round(their_pos, 1),
        "partner": partner,
        "my_paused": mine.get("paused", False),
        "their_paused": theirs.get("paused", False),
        "my_segment": mine.get("segment"),
        "their_segment": theirs.get("segment"),
    }

    if drift > DRIFT_NOTIFY_THRESHOLD_S:
        response["status"] = "ahead"
        response["sync_to"] = int(their_pos)
    elif drift < -0.75:
        # Negative drift = we're behind; soft catch-up if within the soft window.
        response["status"] = "behind"
        response["sync_to"] = int(their_pos)
        response["soft"] = abs(drift) <= SOFT_SYNC_MAX_S
    elif mine.get("paused") or theirs.get("paused"):
        response["status"] = "paused"
    else:
        response["status"] = "in_sync"
    return response


@router.post("/sync/align")
def align_playback() -> dict[str, Any]:
    """Dashboard Sync: bring both users onto the same position.

    Uses the person who is further ahead as the source of truth. The person
    behind gets a soft rate-nudge if the gap is <= 10s, otherwise a hard seek.
    If the leader is playing, both are told to play after aligning.
    """
    if not state.is_connected:
        return {"status": "not_connected"}

    users = list(settings.users)
    a, b = users[0], users[1]
    pa = state.playback.get(a)
    pb = state.playback.get(b)
    if not pa or not pb:
        return {"status": "missing_data"}
    if pa.get("watch_id") != pb.get("watch_id") or not pa.get("watch_id"):
        return {"status": "different_video"}

    now = utcnow()
    pos_a = _estimated_position(pa, now)
    pos_b = _estimated_position(pb, now)

    if pos_a >= pos_b:
        leader, follower, leader_pos, gap = a, b, pos_a, pos_a - pos_b
        leader_paused = pa.get("paused", False)
    else:
        leader, follower, leader_pos, gap = b, a, pos_b, pos_b - pos_a
        leader_paused = pb.get("paused", False)

    soft = gap <= SOFT_SYNC_MAX_S
    seconds = int(leader_pos)

    # Align the follower to the leader.
    bus.publish(
        "command",
        {
            "command": "sync_align",
            "seconds": seconds,
            "source_user": leader,
            "soft": soft,
            "origin": "dashboard",
        },
        target_user=follower,
    )

    # Also nudge the leader onto the exact snapshot (no-op if already there)
    # and ensure play/pause matches the leader.
    bus.publish(
        "command",
        {
            "command": "sync_align",
            "seconds": seconds,
            "source_user": "dashboard",
            "soft": True,
            "origin": "dashboard",
        },
        target_user=leader,
    )

    if not leader_paused:
        for user in (leader, follower):
            bus.publish(
                "command",
                {
                    "command": "sync_play",
                    "seconds": seconds,
                    "source_user": "dashboard",
                    "origin": "dashboard",
                },
                target_user=user,
            )
    else:
        for user in (leader, follower):
            bus.publish(
                "command",
                {
                    "command": "sync_pause",
                    "seconds": seconds,
                    "source_user": "dashboard",
                    "origin": "dashboard",
                },
                target_user=user,
            )

    print(f"[ALIGN] {follower} -> {leader} @ {seconds}s (gap={gap:.1f}s, soft={soft})")
    return {
        "status": "ok",
        "leader": leader,
        "follower": follower,
        "seconds": seconds,
        "gap": round(gap, 1),
        "soft": soft,
    }
