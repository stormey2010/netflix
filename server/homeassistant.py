"""Home Assistant helper bridge for tunnel control."""

import asyncio
import json
import urllib.error
import urllib.request

from tunnel import TunnelManager


class HomeAssistantBridge:
    def __init__(
        self,
        manager: TunnelManager,
        base_url: str,
        token: str,
        entity_id: str,
        poll_seconds: int = 5,
    ):
        self._manager = manager
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._entity_id = entity_id
        self._poll_seconds = poll_seconds
        self._task: asyncio.Task | None = None
        self._last_ha_state: str | None = None
        self._last_published_state: bool | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._base_url and self._token and self._entity_id)

    async def start(self) -> None:
        if self.enabled:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                while True:
                    # Preserve the helper's current state across app/container
                    # restarts. HA remains the authority for tunnel intent.
                    await self._sync_from_home_assistant()
                    await self._sync_state_to_home_assistant()
                    await asyncio.sleep(self._poll_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[HOME ASSISTANT] bridge retrying: {exc}")
                await asyncio.sleep(30)

    async def _sync_from_home_assistant(self) -> None:
        try:
            payload = await self._request(
                "GET", f"/api/states/{self._entity_id}"
            )
            state = str(payload.get("state", "off")).lower()
            if state == self._last_ha_state:
                return
            self._last_ha_state = state
            if state == "on":
                await self._manager.enable()
            elif state == "off":
                await self._manager.disable(reason="home_assistant")
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                print(f"[HOME ASSISTANT] state request failed: HTTP {exc.code}")
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"[HOME ASSISTANT] state request failed: {exc}")
        except RuntimeError as exc:
            print(f"[HOME ASSISTANT] tunnel command rejected: {exc}")

    async def _sync_state_to_home_assistant(self) -> None:
        status = await self._manager.status()
        running = bool(status["running"])
        if running != self._last_published_state:
            await self._set_state(running)

    async def _set_state(self, running: bool) -> None:
        domain, service = self._entity_id.split(".", 1)[0], "turn_on" if running else "turn_off"
        await self._request(
            "POST",
            f"/api/services/{domain}/{service}",
            {"entity_id": self._entity_id},
        )
        self._last_published_state = running

    async def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        return await asyncio.to_thread(self._request_sync, method, path, body)

    def _request_sync(self, method: str, path: str, body: dict | None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read()
        return json.loads(raw) if raw else {}
