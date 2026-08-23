# Netflix Connect

Watch Netflix together with real-time sync and playback controls. A Chrome
extension keeps two people's playback in lockstep while a FastAPI server
relays sync events between them.

## Features

- **Playback sync**: play, pause, seek, speed, and skip-intro are mirrored
  between both users in real time
- **Soft sync**: small drifts (up to ~10s) are corrected by gently nudging the
  lagging side's playback speed until perfectly aligned - no jarring seeks
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
│   │   ├── stream.js          # Single unified SSE connection
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
│   │   ├── events.py          # GET /events/stream (unified SSE)
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
2. Local playback events (play/pause/seek/rate) are relayed to the partner
   through `POST /sync`, which publishes onto the server's event bus.
3. Every client holds **one** SSE connection (`GET /events/stream`) and picks
   the channels it needs (`command`, `nav`, `invite`; the dashboard also
   subscribes to `telemetry`).
4. Incoming commands are applied through the player controller, which opens a
   short suppression window per action type so applied commands are never
   echoed back (no feedback loops).
5. Drift handling: differences up to ~10s are resolved with a gentle playback
   rate adjustment on the lagging side (soft sync); larger gaps hard-seek via
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

<!-- updater smoke test: 0.5.9 -->
