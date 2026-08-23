"""Unified event bus.

All real-time traffic (commands, navigation, invites, telemetry) flows
through one publish/subscribe bus. Extension clients use a duplex WebSocket;
the dashboard and compatibility clients can use the SSE stream.
"""

import asyncio
import json
from dataclasses import dataclass, field

HEARTBEAT_SECONDS = 25.0
QUEUE_MAX = 200


@dataclass
class Subscriber:
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    channels: set[str] | None = None  # None = all channels
    user: str | None = None  # None = receive events for every user (dashboard)


@dataclass
class EventBus:
    _subscribers: list[Subscriber] = field(default_factory=list)

    def subscribe(self, channels: set[str] | None = None, user: str | None = None) -> Subscriber:
        sub = Subscriber(
            queue=asyncio.Queue(maxsize=QUEUE_MAX),
            loop=asyncio.get_running_loop(),
            channels=channels,
            user=user,
        )
        self._subscribers.append(sub)
        return sub

    @staticmethod
    def _enqueue(sub: Subscriber, event: dict) -> None:
        try:
            sub.queue.put_nowait(event)
        except asyncio.QueueFull:
            pass

    def unsubscribe(self, sub: Subscriber) -> None:
        try:
            self._subscribers.remove(sub)
        except ValueError:
            pass

    def publish(self, channel: str, data: dict, target_user: str | None = None) -> None:
        """Deliver an event to matching subscribers.

        If target_user is set, subscribers identified as a different user are
        skipped; anonymous subscribers (the dashboard) receive everything.
        """
        event = {"channel": channel, **data}
        if target_user:
            event["target_user"] = target_user
        for sub in list(self._subscribers):
            if sub.channels is not None and channel not in sub.channels:
                continue
            if target_user and sub.user and sub.user != target_user:
                continue
            try:
                # publish() is also called by FastAPI's synchronous routes,
                # which run in worker threads. Always marshal queue writes to
                # the subscriber's owning event loop so it wakes immediately.
                sub.loop.call_soon_threadsafe(self._enqueue, sub, event)
            except RuntimeError:
                pass  # Subscriber loop closed during disconnect.

    def subscriber_count(self) -> int:
        return len(self._subscribers)


bus = EventBus()


def sse_format(data: dict) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


async def sse_generator(request, sub: Subscriber, initial: dict | None = None):
    """Yield SSE frames for a subscriber until the client disconnects."""
    try:
        if initial is not None:
            yield sse_format(initial)
        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.wait_for(sub.queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield sse_format({"channel": "heartbeat"})
            else:
                yield sse_format(data)
    finally:
        bus.unsubscribe(sub)
