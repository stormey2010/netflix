/**
 * Netflix Connect - Configuration
 * Shared constants used by the content scripts, popup, and setup page.
 */

const NC_API_BASE = 'https://netflix-api.faredrop.xyz';
const NC_API_KEY = '30b742d6-19c5-429d-a13d-f9a24e1464e6';

const NC_CONFIG = {
  API_KEY: NC_API_KEY,
  API_BASE: NC_API_BASE,
  USERS: ['Parker', 'Emily'],

  ENDPOINTS: {
    TELEMETRY: `${NC_API_BASE}/telemetry`,
    EVENTS_STREAM: `${NC_API_BASE}/events/stream`,
    EVENTS_WS: `${NC_API_BASE}/events/ws`,
    COMMAND: `${NC_API_BASE}/command`,
    SYNC: `${NC_API_BASE}/sync`,
    SYNC_DRIFT: `${NC_API_BASE}/sync/drift`,
    SYNC_ALIGN: `${NC_API_BASE}/sync/align`,
    NAV_UPDATE: `${NC_API_BASE}/nav/update`,
    INVITE_SEND: `${NC_API_BASE}/invite/send`,
    INVITE_ACCEPT: `${NC_API_BASE}/invite/accept`,
    INVITE_REJECT: `${NC_API_BASE}/invite/reject`,
    INVITE_STATUS: `${NC_API_BASE}/invite/status`,
    DISCONNECT: `${NC_API_BASE}/disconnect`,
    WATCHLIST: `${NC_API_BASE}/watchlist`,
    WATCHLIST_ADD: `${NC_API_BASE}/watchlist/add`,
    WATCHLIST_REMOVE: `${NC_API_BASE}/watchlist/remove`,
    WATCHLIST_CHECK: `${NC_API_BASE}/watchlist/check`,
    STATS: `${NC_API_BASE}/stats`,
  },

  // Timing
  TELEMETRY_INTERVAL_MS: 2000,
  FAST_TICK_MS: 300,
  SLOW_DEBOUNCE_MS: 400,
  FAST_DEBOUNCE_MS: 100,
  THROTTLE_MS: 300,
  NAV_DELAY_MS: 500,
  DRIFT_CHECK_INTERVAL_MS: 120000, // prompt when far ahead
  CATCHUP_CHECK_INTERVAL_MS: 8000, // auto soft catch-up when behind
  DRIFT_THRESHOLD_S: 5,
  SEEK_APPLY_THRESHOLD_S: 2,   // ignore remote seeks closer than this
  REMOTE_SUPPRESS_MS: 1500,    // echo-suppression window after remote actions

  // Soft sync: for small drifts, nudge playback rate instead of hard seeking
  SOFT_SYNC_MAX_S: 10,         // drifts up to this get rate-nudged, beyond = hard seek
  SOFT_SYNC_MIN_S: 0.75,       // drifts below this are considered in sync already
  SOFT_SYNC_DONE_S: 0.2,       // stop nudging once within this of the target
  SOFT_SYNC_TICK_MS: 250,      // how often to re-evaluate while nudging
  SOFT_SYNC_MAX_ADJUST: 0.4,   // max playback-rate delta (+/-) while nudging
  SOFT_SYNC_BEHIND_BOOST: 0.12,// extra rate boost when catching up from behind
  SOFT_SYNC_TIMEOUT_MS: 60000, // give up nudging after this long

  // Intro / recap segment detection
  SEGMENT_POLL_MS: 1000,

  // SSE retry backoff
  INITIAL_RETRY_MS: 500,
  MAX_RETRY_MS: 5000,
  WS_FALLBACK_DELAY_MS: 700,
  WS_PING_INTERVAL_MS: 10000,
  COMMAND_STALE_MS: 5000,
  EXACT_SYNC_THRESHOLD_S: 0.12,
};

function ncForceHttps(url) {
  return url.replace(/^http:\/\//i, 'https://');
}

// Return a URL with the API key attached as a query parameter
// (EventSource and some fetches cannot set headers).
function ncWithApiKey(url) {
  try {
    const u = new URL(ncForceHttps(url));
    if (!u.searchParams.get('api_key')) u.searchParams.set('api_key', NC_CONFIG.API_KEY);
    return u.toString();
  } catch {
    return url;
  }
}
