"""Pydantic models for the Netflix Connect API."""

from pydantic import BaseModel, Field
from typing import Any


class TelemetryPayload(BaseModel):
    """Playback state report from the extension (every ~2s)."""

    user: str | None = Field(None, description="User identifier")
    time: str = Field(..., description="Client timestamp (ISO 8601)")
    id: str = Field(..., description="Client/session identifier")
    url: str = Field(..., description="Video or page URL")
    rate: float = Field(..., description="Playback rate (1.0 = normal)")
    paused: bool = Field(..., description="Whether playback is paused")
    position_s: float = Field(..., description="Playback position in seconds")
    duration_s: float | None = Field(None, description="Media duration in seconds")
    ready_state: int = Field(..., description="Media readyState value")
    network: str = Field(..., description="Network state label")
    frames: int = Field(..., description="Total frames rendered")
    dropped: int = Field(..., description="Dropped frame count")
    action: str | None = Field(None, description="Optional action marker")


class CommandPayload(BaseModel):
    """Playback command pushed to clients (dashboard controls, shares)."""

    command: str = Field(..., description="play, pause, seek, or share")
    seconds: float | None = Field(None, description="Seek target in seconds")
    target_user: str | None = Field(None, description="Target user, or None for all")
    url: str | None = Field(None, description="URL for share command")
    title: str | None = Field(None, description="Title for share command")
    source_user: str | None = Field(None, description="User who initiated the command")


class SyncPayload(BaseModel):
    """Playback sync event relayed from one user to their partner."""

    command: str = Field(..., description="sync_play, sync_pause, sync_seek, sync_speed, sync_skip, sync_tab_away, sync_tab_back")
    seconds: float = Field(..., description="Playback position in seconds")
    source_user: str = Field(..., description="User who initiated the sync")
    playback_rate: float | None = Field(None, description="Rate for sync_speed")
    skip_type: str | None = Field(None, description="intro, recap, or credits")


class InvitePayload(BaseModel):
    from_user: str = Field(..., description="Sender")
    to_user: str = Field(..., description="Recipient")


class InviteResponse(BaseModel):
    status: str
    invite: dict[str, Any] | None = None
    connection: dict[str, Any] | None = None
    message: str | None = None


class NavUpdatePayload(BaseModel):
    user: str = Field(..., description="User identifier")
    url: str = Field(..., description="Current page URL")
    page_type: str = Field(..., description="watch, browse, search, or other")
    watch_id: str | None = Field(None, description="Video ID if on a watch page")
    position_s: float | None = Field(None, description="Playback position in seconds")


class WatchlistAddPayload(BaseModel):
    netflix_id: str
    title: str
    added_by: str
    image_url: str | None = None
    content_type: str = "unknown"
    notes: str | None = None


class WatchlistRemovePayload(BaseModel):
    netflix_id: str
    title: str | None = None
    removed_by: str | None = None


class UpdateStatsPayload(BaseModel):
    watch_time_s: float
    netflix_id: str | None = None
    title: str | None = None
    is_episode: bool = False


class SessionPayload(BaseModel):
    session_id: str
    netflix_id: str | None = None
    title: str | None = None
    user: str | None = None
    duration_s: float | None = None
