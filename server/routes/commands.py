"""Command routes - explicit playback commands from the dashboard or shares."""

from typing import Any

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import CommandPayload
from state import partner_of, state, utcnow

router = APIRouter(tags=["commands"], dependencies=[Depends(require_api_key)])


def _watch_id_from_url(url: str | None) -> str | None:
    if not url or "/watch/" not in url:
        return None
    return url.split("/watch/", 1)[1].split("?", 1)[0].split("/", 1)[0] or None


def _pull_partner_to_page(payload: CommandPayload, target: str | None) -> bool:
    """If play is on a different video than the partner, navigate them there.

    Returns True when a navigate event was published (play command should be skipped).
    """
    if payload.command != "play" or not payload.source_user or not state.is_connected:
        return False

    source = payload.source_user
    partner = target or partner_of(source)
    if not partner or partner == source:
        return False

    source_nav = state.nav.get(source, {})
    source_url = payload.url or source_nav.get("url")
    source_watch_id = (
        payload.watch_id
        or source_nav.get("watch_id")
        or _watch_id_from_url(source_url)
    )
    if not source_watch_id or not source_url:
        return False

    # Keep source nav fresh from the play event itself.
    state.nav[source] = {
        **source_nav,
        "url": source_url,
        "page_type": "watch",
        "watch_id": source_watch_id,
        "paused": False,
        "updated_at": utcnow().isoformat(),
    }

    partner_nav = state.nav.get(partner, {})
    already_there = (
        partner_nav.get("page_type") == "watch"
        and partner_nav.get("watch_id") == source_watch_id
    )
    if already_there:
        return False

    bus.publish(
        "nav",
        {
            "action": "navigate",
            "url": source_url,
            "reason": f"{source} started playing",
            "seconds": payload.seconds,
            "paused": False,
        },
        target_user=partner,
    )
    print(
        f"[COMMAND] play on different page — pulling {partner} "
        f"to {source_watch_id} @ {payload.seconds}s"
    )
    return True


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

    if _pull_partner_to_page(payload, target):
        return {
            "status": "ok",
            "command": payload.command,
            "target_user": target,
            "navigated": True,
        }

    cmd.pop("target_user", None)
    # Clients don't need page metadata on the command channel.
    cmd.pop("watch_id", None)
    if payload.command != "share":
        cmd.pop("url", None)
        cmd.pop("title", None)

    bus.publish("command", cmd, target_user=target)
    return {"status": "ok", "command": payload.command, "target_user": target}
