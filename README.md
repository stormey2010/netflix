# Netflix Connect

Watch Netflix together with real-time sync and playback controls. A Chrome
extension keeps two people's playback in lockstep while a FastAPI server
relays sync events between them.

## Features

- **Playback sync**: play, pause, seek, speed, and skip-intro are mirrored
  between both users in real time
- **Soft sync**: when someone is less than 10s behind, they catch up smoothly
  at 1.25x; gaps of 10s or more hard-seek to the current position
- **Navigation sync**: when one user starts watching, the other is brought along
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
│   │   ├── utils.js           # Video/network/ticker helpers
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
├── config.yml                 # Cloudflare tunnel ingress
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
6. Commands carry millisecond positions, monotonic sequence IDs, and timing
   metadata. Receivers discard stale/out-of-order events and compensate a
   playing target for measured network transit time. Drift handling:
   gaps under 10s are resolved by playing the lagging side at 1.25x; gaps of
   10s or more hard-seek via
   Netflix's player API through `page-bridge.js`.

### Authentication

- Every API endpoint requires the API key (via `X-API-Key` header or
  `api_key` query parameter for SSE).
- The dashboard uses a password login that issues a signed, expiring session
  cookie; the same-origin dashboard fetches are authorized by that cookie.
- Secrets live in `server/secrets.yml` (or `NC_API_KEY` /
  `NC_DASHBOARD_PASSWORD` environment variables).

## Running the server

```bash
cd server
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8767
```

or double-click `start-server.bat` on Windows. The server also starts the
Cloudflare tunnel automatically if `cloudflared` is installed at
`C:\cloudflared\cloudflared.exe` (configurable in `server/config.py`).

Dashboard: <http://localhost:8767/dashboard>

## Installing the extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension` folder
4. Pick your profile on the setup page that opens

<!-- updater smoke test: 0.7.2 -->
