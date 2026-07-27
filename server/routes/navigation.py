"""Navigation routes - track where each user is and keep partners together."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import NavUpdatePayload
from state import partner_of, state, utcnow, validate_user

router = APIRouter(tags=["navigation"], dependencies=[Depends(require_api_key)])


def _sync_partner(payload: NavUpdatePayload, old: dict[str, Any]) -> None:
    partner = partner_of(payload.user)
    partner_nav = state.nav.get(partner, {})

    started_watching = payload.page_type == "watch" and old.get("page_type") != "watch"
    switched_video = (
        payload.page_type == "watch"
        and old.get("page_type") == "watch"
        and payload.watch_id != old.get("watch_id")
    )
    left_watching = payload.page_type != "watch" and old.get("page_type") == "watch"

    if started_watching or switched_video:
        already_there = (
            partner_nav.get("page_type") == "watch"
            and partner_nav.get("watch_id") == payload.watch_id
        )
        if not already_there:
            reason = (
                f"{payload.user} switched videos"
                if switched_video
                else f"{payload.user} started watching"
            )
            bus.publish(
                "nav",
                {"action": "navigate", "url": payload.url, "reason": reason},
                target_user=partner,
            )
            print(f"[NAV SYNC] Bringing {partner} to {payload.watch_id}")

            if started_watching and payload.position_s is not None:
                bus.publish(
                    "command",
                    {
                        "command": "sync_seek",
                        "seconds": int(payload.position_s),
                        "source_user": payload.user,
                    },
                    target_user=partner,
                )

    elif left_watching and partner_nav.get("page_type") == "watch":
        bus.publish(
            "command",
            {"command": "sync_pause", "seconds": 0, "source_user": payload.user},
            target_user=partner,
        )
        bus.publish(
            "command",
            {
                "command": "partner_left",
                "source_user": payload.user,
                "message": f"{payload.user} left the video",
            },
            target_user=partner,
        )
        print(f"[NAV SYNC] {payload.user} left video, pausing {partner}")


@router.post("/nav/update")
def update_nav(payload: NavUpdatePayload) -> dict[str, Any]:
    try:
        validate_user(payload.user)
    except ValueError as e:
        return {"status": "error", "message": str(e)}

    old = state.nav.get(payload.user, {})
    state.nav[payload.user] = {
        "url": payload.url,
        "page_type": payload.page_type,
        "watch_id": payload.watch_id,
        "updated_at": utcnow().isoformat(),
    }

    print(
        f"[NAV] {payload.user}: {payload.page_type}"
        + (f" ({payload.watch_id})" if payload.watch_id else "")
    )

    if state.is_connected:
        _sync_partner(payload, old)

    return {"status": "ok", "synced": state.is_connected}


@router.get("/nav/state")
def get_nav_state() -> dict[str, Any]:
    return {"connected": state.is_connected, "users": state.nav}
