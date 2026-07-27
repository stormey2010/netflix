"""Unified SSE stream - the single real-time connection for all clients.

Channels:
- command:   playback commands and sync events
- nav:       navigation sync (follow partner to a video)
- invite:    invite/connection lifecycle events
- telemetry: live playback snapshots (used by the dashboard)

Clients pick channels via ?channels=command,nav,invite and identify
themselves with ?user=Parker so targeted events are filtered server-side.
"""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from auth import require_api_key
from bus import bus, sse_generator
from state import state

router = APIRouter(tags=["events"], dependencies=[Depends(require_api_key)])

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@router.get("/events/stream")
async def event_stream(request: Request, user: str = "", channels: str = ""):
    channel_set = {c.strip() for c in channels.split(",") if c.strip()} or None
    sub = bus.subscribe(channels=channel_set, user=user or None)

    initial = {
        "channel": "init",
        "invite": state.invite,
        "connection": state.connection,
    }
    return StreamingResponse(
        sse_generator(request, sub, initial=initial),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
