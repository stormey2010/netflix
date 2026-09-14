# Streaming Connect

Watch together across Netflix, YouTube, Prime Video, Hulu, Peacock, and
Disney+. The Chrome extension keeps each provider's playback independent while
the FastAPI server relays only matching-provider sync events.

## Features

- **Playback sync**: play, pause, seek, speed, and skip-intro are mirrored
  between both users in real time
- **Provider adapters**: each service has isolated player discovery, identity,
  controls, duration, and edge-state handling
- **Independent services**: a failed Prime or Hulu adapter cannot interrupt a
  Netflix session, and cross-provider commands are ignored safely
- **Soft sync**: proven providers use gentle catch-up; providers without a
  reliable physical rate API use precise seeks instead
- **Navigation sync**: matching-provider playback can bring the other person
  along; users on different services remain independent
- **Invites**: connect via an in-page invite with accept/decline
- **Shared watchlist**: save titles for each other from the Netflix detail modal
- **Dashboard**: live monitor for both users with playback controls, an
  activity feed, watchlist, and stats

## Architecture

```
netflix/
├── extension/                 # Chrome Extension (Manifest V3, vanilla JS)
│   ├── js/
│   │   ├── config.js          # API endpoints, timings, constants
│   │   ├── providers.js       # Netflix, YouTube, Prime, Hulu, Peacock, Disney+
│   │   ├── utils.js           # Provider-aware video/network/ticker helpers
│   │   ├── user.js            # Profile identity (chrome.storage.sync)
│   │   ├── player.js          # Playback controller: remote actions, echo
│   │   │                      #   suppression, soft sync (rate nudging)
│   │   ├── stream.js          # WebSocket transport + SSE fallback
│   │   ├── telemetry.js       # Playback state reporting (every 2s)
│   │   ├── sync.js            # Outbound events + inbound command execution
│   │   ├── navigation.js      # URL tracking & follow-partner
│   │   ├── notifications.js   # In-page toasts, invites, status badge
│   │   ├── share-button.js    # Share/watchlist buttons in detail modal
│   │   ├── injector.js        # Page-context script injection
│   │   ├── messages.js        # Popup messaging
│   │   └── main.js            # Boot
│   ├── page-bridge.js         # Page-context seek via Netflix's player API
│   ├── page-ui.js             # "Watching Together" banner
│   ├── popup.html/js          # Popup: session, watchlist, stats
│   ├── setup.html/js          # Profile picker
│   └── manifest.json
│
├── server/                    # FastAPI backend
│   ├── app.py                 # App entry: CORS, routers, tunnel lifespan
│   ├── config.py              # Settings + secrets loading (single source)
│   ├── auth.py                # API-key dependency + signed dashboard sessions
│   ├── bus.py                 # Unified pub/sub event bus + SSE helpers
│   ├── state.py               # In-memory session state
│   ├── schemas.py             # Pydantic models
│   ├── database.py            # SQLite: watchlist, stats, sessions
│   ├── requirements.txt
│   ├── routes/
│   │   ├── telemetry.py       # POST /telemetry, GET /telemetry/all
│   │   ├── sync.py            # POST /sync, GET /sync/drift
│   │   ├── commands.py        # POST /command (dashboard controls, shares)
│   │   ├── navigation.py      # POST /nav/update, GET /nav/state
│   │   ├── invites.py         # Invite lifecycle + /disconnect
│   │   ├── library.py         # Watchlist / stats / sessions
│   │   ├── events.py          # WebSocket + unified SSE fallback
│   │   └── dashboard.py       # Dashboard login + UI
│   └── templates/
│       ├── dashboard.html
│       └── dashboard_login.html
│
├── config.yml                 # Windows/local Cloudflare tunnel ingress (legacy)
├── Dockerfile                 # Linux production image
├── docker-compose.yml         # LAN-only origin deployment
└── homeassistant/             # On-demand tunnel control notes
└── start-server.bat           # Windows quick start
```

### How sync works

1. Each client reports telemetry every 2 seconds (`POST /telemetry`).
2. Local playback events (play/pause/seek/rate) are sent immediately through
   the open WebSocket and relayed through the server's event bus.
3. Every extension client holds one duplex WebSocket (`GET /events/ws`) and
   sends playback events over that same connection. This removes the extra
   HTTP request from play/pause/seek. SSE + HTTP remain an automatic fallback;
   the dashboard continues to subscribe to telemetry over SSE.
4. Incoming commands are applied through the player controller, which opens a
   short suppression window per action type so applied commands are never
   echoed back (no feedback loops).
5. Playback state has one authority: explicit media events. Telemetry observes
   state but never emits play/pause commands, and transient pause/play events
   produced while seeking are ignored.
6. Commands carry millisecond positions, provider/media identity, monotonic
   sequence IDs, and timing
   metadata. Receivers discard stale/out-of-order events and compensate a
   playing target for measured network transit time. Drift handling uses
   provider capabilities: Netflix and Peacock can use 1.25x catch-up, while
   YouTube, Prime Video, Hulu, and Disney+ use seek-based correction until a
   reliable physical rate path is available.

### Supported providers

The adapter registry targets the tested player surfaces from the playback
findings: YouTube's `#movie_player`, Prime's scored `dv-web-player` surfaces,
Hulu's `#content-video-player` and timeline fallback, Peacock's
`#core-video-shaka`, and Disney+'s `#hivePlayer1`. Hidden ad, intro, buffering,
still-watching, error, and up-next elements are treated as blocking states so
normal sync is not forced through non-content playback.

### Authentication

- Every API endpoint requires the API key (via `X-API-Key` header or
  `api_key` query parameter for SSE).
- The dashboard uses a password login that issues a signed, expiring session
  cookie; the same-origin dashboard fetches are authorized by that cookie.
- Secrets live in `server/secrets.yml` (or `NC_API_KEY` /
  `NC_DASHBOARD_PASSWORD` environment variables). The Docker deployment also
  reads the server-only Cloudflare credential directory and
  `NC_TUNNEL_CONTROL_TOKEN` from its `.env` file.

## Running the server

```bash
cd server
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8767
```

or double-click `start-server.bat` on Windows. Cloudflare is not started by
the API process. In Docker, Home Assistant controls it through
`POST /control/tunnel`; every enable request expires after three hours and a
process shutdown also stops it.

### Docker deployment

The compose file binds the origin to `192.168.42.30:8767` only. With the
tunnel stopped, the service is LAN-only. Put the matching tunnel credential
JSON in `cloudflared/` with host permissions `0600` and a separate random
`NC_TUNNEL_CONTROL_TOKEN` in the server's `.env`, then run:

```bash
docker compose up -d --build
```

The Home Assistant tunnel switch is
`switch.netflix_connect_netflix_connect_cloudflare_tunnel`. The app controls it through
the HA API when `NC_HOME_ASSISTANT_URL`, `NC_HOME_ASSISTANT_TOKEN`, and
`NC_HOME_ASSISTANT_ENTITY_ID` are present; the token stays server-side.

Dashboard: <http://localhost:8767/dashboard>

## Installing the extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension` folder
4. Pick your profile on the setup page that opens

<!-- release target: 0.8.0; macOS updater protocol remains 4+ -->
