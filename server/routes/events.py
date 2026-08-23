"""Unified WebSocket transport and SSE compatibility stream.

Channels:
- command:   playback commands and sync events
- nav:       navigation sync (follow partner to a video)
- invite:    invite/connection lifecycle events
- telemetry: live playback snapshots (used by the dashboard)

Clients pick channels via ?channels=command,nav,invite and identify
themselves with ?user=Parker so targeted events are filtered server-side.
"""

import asyncio
import time

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from auth import require_api_key
from bus import bus, sse_generator
from state import partner_of, state, validate_user

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


@router.websocket("/events/ws")
async def event_socket(websocket: WebSocket, user: str = "", channels: str = ""):
    """Duplex low-latency transport; SSE/HTTP remain the fallback."""
    try:
        validate_user(user)
    except ValueError:
        await websocket.close(code=1008, reason="invalid user")
        return
    await websocket.accept()
    channel_set = {c.strip() for c in channels.split(",") if c.strip()} or None
    sub = bus.subscribe(channels=channel_set, user=user or None)

    async def send_events() -> None:
        await websocket.send_json({
            "channel": "init",
            "invite": state.invite,
            "connection": state.connection,
            "server_sent_ms": time.time() * 1000,
        })
        while True:
            event = dict(await sub.queue.get())
            event["server_sent_ms"] = time.time() * 1000
            await websocket.send_json(event)

    async def receive_events() -> None:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            if message_type == "ping":
                received_ms = time.time() * 1000
                await websocket.send_json({
                    "type": "pong",
                    "client_sent_ms": message.get("client_sent_ms"),
                    "server_received_ms": received_ms,
                    "server_sent_ms": time.time() * 1000,
                })
                continue
            if message_type != "sync" or not user:
                continue

            command = message.get("command")
            seconds = message.get("seconds")
            if not isinstance(command, str) or not isinstance(seconds, (int, float)):
                continue

            event = {
                key: value
                for key, value in message.items()
                if key in {
                    "command", "seconds", "playback_rate", "skip_type",
                    "segment", "soft", "paused", "rate", "event_id",
                    "stream_id", "seq", "client_sent_ms", "resume",
                }
                and value is not None
            }
            event.update({
                "source_user": user,
                "server_received_ms": time.time() * 1000,
                "transport": "websocket",
            })
            bus.publish("command", event, target_user=partner_of(user))

    sender = asyncio.create_task(send_events())
    receiver = asyncio.create_task(receive_events())
    try:
        done, pending = await asyncio.wait(
            {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.gather(*done, return_exceptions=True)
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        pass
    finally:
        sender.cancel()
        receiver.cancel()
        await asyncio.gather(sender, receiver, return_exceptions=True)
        bus.unsubscribe(sub)
