/**
 * Netflix Connect - Utilities
 * Video inspection, networking, and timing helpers shared by all modules.
 */

// === Video helpers ===

function ncGetVideo() {
  return document.querySelector('video');
}

function ncIsPlaying(video) {
  return !video.paused && !video.ended && video.playbackRate > 0 && video.readyState >= 2;
}

function ncNetworkStateLabel(state) {
  switch (state) {
    case 0: return 'NETWORK_EMPTY';
    case 1: return 'NETWORK_IDLE';
    case 2: return 'NETWORK_LOADING';
    case 3: return 'NETWORK_NO_SOURCE';
    default: return 'UNKNOWN';
  }
}

function ncReadQuality(video) {
  let frames = null;
  let dropped = null;
  try {
    if (typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      if (q) {
        frames = Number.isFinite(q.totalVideoFrames) ? q.totalVideoFrames : null;
        dropped = Number.isFinite(q.droppedVideoFrames) ? q.droppedVideoFrames : null;
      }
    } else {
      frames = Number.isFinite(video.webkitDecodedFrameCount) ? video.webkitDecodedFrameCount : null;
      dropped = Number.isFinite(video.webkitDroppedFrameCount) ? video.webkitDroppedFrameCount : null;
    }
  } catch {}
  return { frames, dropped };
}

function ncDescribeVideo(video) {
  const { frames, dropped } = ncReadQuality(video);
  const pageUrl = window.location?.href || null;
  const cleanPageUrl = pageUrl ? pageUrl.split('?')[0] : null;

  return {
    currentTimeS: Number.isFinite(video.currentTime) ? video.currentTime : null,
    durationS: Number.isFinite(video.duration) ? video.duration : null,
    playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : null,
    volume: Number.isFinite(video.volume) ? video.volume : null,
    muted: !!video.muted,
    ended: !!video.ended,
    seeking: !!video.seeking,
    readyState: video.readyState,
    networkState: video.networkState,
    frames,
    dropped,
    sourceId: ncGetWatchId(),
    sourceUrl: cleanPageUrl,
  };
}

// === Page helpers ===

function ncGetPageType() {
  const url = window.location.href;
  if (url.includes('/watch/')) return 'watch';
  if (url.includes('/title/')) return 'browse';
  if (url.includes('/browse')) return 'browse';
  if (url.includes('/search')) return 'search';
  return 'other';
}

function ncGetWatchId() {
  const url = window.location.href;
  if (!url.includes('/watch/')) return null;
  try {
    return url.split('/watch/')[1].split('?')[0].split('/')[0];
  } catch {
    return null;
  }
}

// === Timing helpers ===

function ncThrottle(fn, ms) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= ms) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

function ncDeferredCall(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: 500 });
  } else {
    setTimeout(fn, 0);
  }
}

// === Networking ===

async function ncPost(endpoint, data) {
  const response = await fetch(ncWithApiKey(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': NC_CONFIG.API_KEY,
    },
    body: JSON.stringify(data),
  });
  return response.json();
}

async function ncGet(endpoint) {
  const response = await fetch(ncWithApiKey(endpoint), {
    headers: { 'X-API-Key': NC_CONFIG.API_KEY },
  });
  if (!response.ok) throw new Error(`GET ${endpoint} -> ${response.status}`);
  return response.json();
}

// SSE factory with exponential-backoff reconnect.
function ncCreateSSE(url, onMessage, options = {}) {
  const state = { source: null, retryMs: NC_CONFIG.INITIAL_RETRY_MS, stopped: false };

  function connect() {
    if (state.stopped) return;
    if (state.source) {
      state.source.close();
      state.source = null;
    }

    const es = new EventSource(ncWithApiKey(url));
    state.source = es;

    es.onopen = () => {
      state.retryMs = NC_CONFIG.INITIAL_RETRY_MS;
      if (options.onOpen) options.onOpen();
    };

    es.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data || '{}'));
      } catch {}
    };

    es.onerror = () => {
      es.close();
      state.source = null;
      if (state.stopped) return;
      const delay = Math.min(state.retryMs, NC_CONFIG.MAX_RETRY_MS);
      state.retryMs = Math.min(state.retryMs * 2, NC_CONFIG.MAX_RETRY_MS);
      setTimeout(connect, delay);
    };
  }

  return {
    start: connect,
    stop: () => {
      state.stopped = true;
      if (state.source) {
        state.source.close();
        state.source = null;
      }
    },
    isConnected: () => state.source?.readyState === EventSource.OPEN,
  };
}

// === Unified ticker ===
// Two shared intervals (fast: URL/modal polling, slow: telemetry) instead of
// each module owning its own setInterval.

const ncTicker = {
  fastCallbacks: [],
  slowCallbacks: [],
  fastIntervalId: null,
  slowIntervalId: null,
  started: false,

  onFastTick(fn) { this.fastCallbacks.push(fn); },
  onSlowTick(fn) { this.slowCallbacks.push(fn); },

  off(fn) {
    this.fastCallbacks = this.fastCallbacks.filter((f) => f !== fn);
    this.slowCallbacks = this.slowCallbacks.filter((f) => f !== fn);
  },

  start() {
    if (this.started) return;
    this.started = true;
    const run = (fns) => fns.forEach((fn) => {
      try { fn(); } catch (e) { console.error('[Netflix Connect] tick error:', e); }
    });
    this.fastIntervalId = setInterval(() => run(this.fastCallbacks), NC_CONFIG.FAST_TICK_MS);
    this.slowIntervalId = setInterval(() => run(this.slowCallbacks), NC_CONFIG.TELEMETRY_INTERVAL_MS);
  },

  stop() {
    clearInterval(this.fastIntervalId);
    clearInterval(this.slowIntervalId);
    this.fastIntervalId = null;
    this.slowIntervalId = null;
    this.started = false;
  },
};
