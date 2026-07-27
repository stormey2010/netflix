"""In-memory session state.

Holds everything that is ephemeral: the current invite/connection, the latest
telemetry snapshot per user, drift-tracking playback state, and navigation
state. Persistent data (watchlist, stats) lives in database.py.
"""

from datetime import datetime, timezone
from typing import Any

from config import ALLOWED_USERS, partner_of, validate_user  # re-exported for routes


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SessionState:
    def __init__(self) -> None:
        self.invite: dict[str, Any] | None = None
        self.connection: dict[str, Any] | None = None
        # user -> latest full telemetry snapshot (payload dict + received_at)
        self.telemetry: dict[str, dict[str, Any]] = {}
        # user -> compact playback state used for drift estimation
        self.playback: dict[str, dict[str, Any]] = {}
        # user -> navigation state (url, page_type, watch_id)
        self.nav: dict[str, dict[str, Any]] = {}

    @property
    def is_connected(self) -> bool:
        return self.connection is not None

    def set_connection(self, users: list[str]) -> dict[str, Any]:
        self.connection = {
            "users": users,
            "established_at": utcnow().isoformat(),
        }
        self.invite = None
        return self.connection

    def clear_connection(self) -> None:
        self.connection = None

    def snapshot(self) -> dict[str, Any]:
        """Full state snapshot used by SSE init events and the dashboard."""
        return {
            "invite": self.invite,
            "connection": self.connection,
            "telemetry": self.telemetry,
            "nav": self.nav,
        }


state = SessionState()
