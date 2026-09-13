"""Navigation routes - track where each user is and keep partners together."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import NavUpdatePayload
from state import partner_of, state, utcnow, validate_user

router = APIRouter(tags=["navigation"], dependencies=[Depends(require_api_key)])


def _service_from_url(url: str) -> str | None:
    host = (url or "").split("/", 3)[2].lower() if "://" in (url or "") else ""
    host = host.removeprefix("www.")
    return {
        "netflix.com": "netflix", "youtube.com": "youtube", "youtu.be": "youtube",
        "primevideo.com": "prime", "hulu.com": "hulu", "peacocktv.com": "peacock",
        "disneyplus.com": "disney",
    }.get(host)


def _sync_partner(payload: NavUpdatePayload, old: dict[str, Any]) -> None:
    partner = partner_of(payload.user)
    service = payload.service or _service_from_url(payload.url)
    partner_nav = state.nav.get(partner, {})

    # After a play-to-nav pull, the follower reports the new page. Do not push
    # their still-loading playback state back onto the person already watching.
    if payload.followed:
        print(f"[NAV] {payload.user} landed after follow — skip reverse sync")
        return

    started_watching = payload.page_type == "watch" and old.get("page_type") != "watch"
    switched_video = (
        payload.page_type == "watch"
        and old.get("page_type") == "watch"
        and (service, payload.media_id or payload.watch_id)
        != (old.get("service"), old.get("media_id") or old.get("watch_id"))
    )
    left_watching = payload.page_type != "watch" and old.get("page_type") == "watch"

    if started_watching or switched_video:
        # A partner watching another provider is an independent playback
        # session. Do not navigate or interrupt that provider's tab.
        if partner_nav.get("page_type") == "watch" and partner_nav.get("service") and service and partner_nav.get("service") != service:
            return
        already_there = (
            partner_nav.get("page_type") == "watch"
            and partner_nav.get("watch_id") == payload.watch_id
            and partner_nav.get("service") == service
        )
        reason = (
            f"{payload.user} switched videos"
            if switched_video
            else f"{payload.user} started watching"
        )
        if not already_there:
            bus.publish(
                "nav",
                {
                    "action": "navigate",
                    "url": payload.url,
                    "reason": reason,
                    "seconds": payload.position_s,
                    "paused": payload.paused,
                    "service": service,
                    "media_id": payload.media_id or payload.watch_id,
                },
                target_user=partner,
            )
            print(f"[NAV SYNC] Bringing {partner} to {payload.watch_id}")
        elif payload.position_s is not None:
            # Partner is still on this title (usually paused because the source
            # briefly left). Restore both position and playback state.
            bus.publish(
                "command",
                {
                    "command": "sync_pause" if payload.paused else "sync_play",
                    "seconds": payload.position_s,
                    "source_user": payload.user,
                    "service": service,
                    "media_id": payload.media_id or payload.watch_id,
                    "origin": "navigation_return",
                },
                target_user=partner,
            )

    elif left_watching and partner_nav.get("page_type") == "watch":
        bus.publish(
            "command",
            {"command": "sync_pause", "source_user": payload.user},
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
    service = payload.service or _service_from_url(payload.url)
    state.nav[payload.user] = {
        "url": payload.url,
        "page_type": payload.page_type,
        "watch_id": payload.watch_id,
        "media_id": payload.media_id or payload.watch_id,
        "service": service,
        "service_name": payload.service_name or service,
        "title": payload.title,
        "paused": payload.paused,
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
