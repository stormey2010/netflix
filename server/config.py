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
    port: int = 8767
    cloudflared_path: str = r"C:\cloudflared\cloudflared.exe"
    tunnel_name: str = "netflixapi"
    tunnel_token: str = ""
    tunnel_config_path: str = ""
    tunnel_id: str = ""
    tunnel_control_token: str = ""
    tunnel_max_hours: int = 3
    home_assistant_url: str = ""
    home_assistant_token: str = ""
    home_assistant_entity_id: str = "switch.netflix_connect_netflix_connect_cloudflare_tunnel"
    # Ingress config (hostname -> localhost mapping) lives at the repo root.
    tunnel_config_path: Path = SERVER_DIR.parent / "config.yml"
    db_path: Path = Path(
        os.environ.get("NC_DB_PATH", str(SERVER_DIR / "netflix_connect.db"))
    )
    dashboard_session_hours: int = 8


settings = Settings(
    api_key=_secrets.get("api_key")
    or os.environ.get("NC_API_KEY", "changeme-supersecret-key"),
    dashboard_password=_secrets.get("dashboard_password")
    or os.environ.get("NC_DASHBOARD_PASSWORD", "changeme-dashboard-pass"),
    tunnel_token=_secrets.get("tunnel_token") or os.environ.get("NC_TUNNEL_TOKEN", ""),
    tunnel_config_path=os.environ.get("NC_TUNNEL_CONFIG_PATH", ""),
    tunnel_id=os.environ.get("NC_TUNNEL_ID", ""),
    tunnel_control_token=(
        _secrets.get("tunnel_control_token")
        or os.environ.get("NC_TUNNEL_CONTROL_TOKEN", "")
    ),
    tunnel_max_hours=int(os.environ.get("NC_TUNNEL_MAX_HOURS", "3")),
    home_assistant_url=os.environ.get("NC_HOME_ASSISTANT_URL", ""),
    home_assistant_token=os.environ.get("NC_HOME_ASSISTANT_TOKEN", ""),
    home_assistant_entity_id=os.environ.get(
        "NC_HOME_ASSISTANT_ENTITY_ID",
        "switch.netflix_connect_netflix_connect_cloudflare_tunnel",
    ),
)

ALLOWED_USERS: set[str] = set(settings.users)


def partner_of(user: str) -> str:
    """Return the other user in the two-person pair."""
    a, b = settings.users
    return b if user == a else a


def validate_user(user: str) -> None:
    if user not in ALLOWED_USERS:
        raise ValueError(f"user must be one of {sorted(ALLOWED_USERS)}")
