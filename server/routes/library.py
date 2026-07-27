"""Library routes - shared watchlist, watch stats, and sessions."""

from typing import Any

from fastapi import APIRouter, Depends, Query

import database as db
from auth import require_api_key
from bus import bus
from schemas import (
    SessionPayload,
    UpdateStatsPayload,
    WatchlistAddPayload,
    WatchlistRemovePayload,
)

router = APIRouter(tags=["library"], dependencies=[Depends(require_api_key)])


def _notify_watchlist(command: str, netflix_id: str, title: str, actor: str) -> None:
    """Notify everyone about a watchlist change (clients differentiate by actor)."""
    payload = {"command": command, "netflix_id": netflix_id, "title": title}
    actor_key = "added_by" if command == "watchlist_added" else "removed_by"
    payload[actor_key] = actor
    bus.publish("command", payload)


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------

@router.get("/watchlist")
def get_watchlist(limit: int = Query(50, ge=1, le=100)) -> dict[str, Any]:
    items = db.get_watchlist(limit)
    return {"status": "ok", "count": len(items), "watchlist": items}


@router.post("/watchlist/add")
def add_to_watchlist(payload: WatchlistAddPayload) -> dict[str, Any]:
    result = db.add_to_watchlist(
        netflix_id=payload.netflix_id,
        title=payload.title,
        added_by=payload.added_by,
        image_url=payload.image_url,
        content_type=payload.content_type,
        notes=payload.notes,
    )
    if result["status"] == "added":
        _notify_watchlist("watchlist_added", payload.netflix_id, payload.title, payload.added_by)
    return result


@router.post("/watchlist/remove")
def remove_from_watchlist(payload: WatchlistRemovePayload) -> dict[str, Any]:
    result = db.remove_from_watchlist(payload.netflix_id)
    if result["status"] == "removed" and payload.title:
        _notify_watchlist(
            "watchlist_removed", payload.netflix_id, payload.title, payload.removed_by or "Someone"
        )
    return result


@router.get("/watchlist/check/{netflix_id}")
def check_watchlist(netflix_id: str) -> dict[str, Any]:
    return {"netflix_id": netflix_id, "in_watchlist": db.is_in_watchlist(netflix_id)}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@router.get("/stats")
def get_stats(days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    return db.get_watch_stats(days)


@router.post("/stats/update")
def update_stats(payload: UpdateStatsPayload) -> dict[str, Any]:
    return db.update_watch_stats(
        watch_time_s=payload.watch_time_s,
        netflix_id=payload.netflix_id,
        title=payload.title,
        is_episode=payload.is_episode,
    )


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@router.post("/session/start")
def start_session(payload: SessionPayload) -> dict[str, Any]:
    return db.start_session(payload.session_id, payload.netflix_id, payload.title)


@router.post("/session/end")
def end_session(payload: SessionPayload) -> dict[str, Any]:
    if not payload.duration_s:
        return {"status": "error", "message": "duration_s required"}
    return db.end_session(payload.session_id, payload.duration_s)


@router.post("/session/join")
def join_session(payload: SessionPayload) -> dict[str, Any]:
    if not payload.user:
        return {"status": "error", "message": "user required"}
    return db.join_session(payload.session_id, payload.user)
