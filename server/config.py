"""Central configuration for Netflix Connect.

Secrets are loaded once from secrets.yml (or environment variables) and
exposed through a single immutable `settings` object so no module ever has
to import them from app.py.
"""

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

SERVER_DIR = Path(__file__).parent


def _load_secrets() -> dict:
    path = SERVER_DIR / "secrets.yml"
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


_secrets = _load_secrets()


@dataclass(frozen=True)
class Settings:
    api_key: str
    dashboard_password: str
    users: tuple[str, str] = ("Parker", "Emily")
    host: str = "0.0.0.0"
    port: int = 8765
    cloudflared_path: str = r"C:\cloudflared\cloudflared.exe"
    tunnel_name: str = "netflixapi"
    db_path: Path = SERVER_DIR / "netflix_connect.db"
    dashboard_session_hours: int = 8


settings = Settings(
    api_key=_secrets.get("api_key")
    or os.environ.get("NC_API_KEY", "changeme-supersecret-key"),
    dashboard_password=_secrets.get("dashboard_password")
    or os.environ.get("NC_DASHBOARD_PASSWORD", "changeme-dashboard-pass"),
)

ALLOWED_USERS: set[str] = set(settings.users)


def partner_of(user: str) -> str:
    """Return the other user in the two-person pair."""
    a, b = settings.users
    return b if user == a else a


def validate_user(user: str) -> None:
    if user not in ALLOWED_USERS:
        raise ValueError(f"user must be one of {sorted(ALLOWED_USERS)}")
