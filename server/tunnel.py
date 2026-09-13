"""Optional Cloudflare Tunnel lifecycle management."""

import asyncio
import os
import time
from datetime import datetime, timezone


class TunnelManager:
    """Start cloudflared on demand and stop it no later than the deadline."""

    def __init__(
        self,
        token: str,
        config_path: str = "",
        tunnel_id: str = "",
        binary: str = "cloudflared",
        max_hours: int = 3,
    ):
        self._token = token
        self._config_path = config_path
        self._tunnel_id = tunnel_id
        self._binary = binary
        self._max_seconds = max_hours * 60 * 60
        self._process: asyncio.subprocess.Process | None = None
        self._expires_at: float | None = None
        self._stop_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def _running(self) -> bool:
        return bool(self._process and self._process.returncode is None)

    @staticmethod
    def _iso(timestamp: float | None) -> str | None:
        if timestamp is None:
            return None
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()

    async def status(self) -> dict:
        async with self._lock:
            if self._process and self._process.returncode is not None:
                self._process = None
                self._expires_at = None
            return self._status_unlocked()

    async def enable(self) -> dict:
        async with self._lock:
            if not self._token and not (self._config_path and self._tunnel_id):
                raise RuntimeError("Cloudflare tunnel credentials are not configured")

            if not self._running():
                environment = os.environ.copy()
                if self._token:
                    environment["TUNNEL_TOKEN"] = self._token
                    command = [self._binary, "tunnel", "--no-autoupdate", "run"]
                else:
                    command = [
                        self._binary,
                        "tunnel",
                        "--no-autoupdate",
                        "--config",
                        self._config_path,
                        "run",
                        self._tunnel_id,
                    ]
                self._process = await asyncio.create_subprocess_exec(
                    *command,
                    env=environment,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=None,
                )

            self._expires_at = time.time() + self._max_seconds
            if self._stop_task:
                self._stop_task.cancel()
            self._stop_task = asyncio.create_task(self._stop_after_deadline())
            return self._status_unlocked()

    async def disable(self, reason: str = "manual") -> dict:
        async with self._lock:
            await self._stop_unlocked()
            result = self._status_unlocked()
            result["stopped_reason"] = reason
            return result

    async def shutdown(self) -> None:
        async with self._lock:
            await self._stop_unlocked()

    def _status_unlocked(self) -> dict:
        remaining = max(0, int((self._expires_at or 0) - time.time()))
        return {
            "running": self._running(),
            "expires_at": self._iso(self._expires_at),
            "remaining_seconds": remaining,
            "max_hours": self._max_seconds // 3600,
        }

    async def _stop_after_deadline(self) -> None:
        try:
            await asyncio.sleep(self._max_seconds)
            await self.disable(reason="3_hour_timeout")
        except asyncio.CancelledError:
            pass

    async def _stop_unlocked(self) -> None:
        if self._stop_task and self._stop_task is not asyncio.current_task():
            self._stop_task.cancel()
        self._stop_task = None
        process = self._process
        self._process = None
        self._expires_at = None
        if not process or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
