"""Routes package - exports all route modules."""

from .commands import router as commands_router
from .dashboard import router as dashboard_router
from .events import router as events_router
from .invites import router as invites_router
from .library import router as library_router
from .navigation import router as navigation_router
from .sync import router as sync_router
from .telemetry import router as telemetry_router

__all__ = [
    "commands_router",
    "dashboard_router",
    "events_router",
    "invites_router",
    "library_router",
    "navigation_router",
    "sync_router",
    "telemetry_router",
]
