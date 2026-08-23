/**
 * Netflix Connect - Telemetry
 * Reports playback state to the server every couple of seconds, plus
 * immediate pushes for notable actions (play/pause/seek).
 */

const ncTelemetry = {
  started: false,
  tickCallback: null,

  async push(extra = {}) {
    if (typeof ncSession !== 'undefined' && !ncSession.isActive()) return;
    const video = ncGetVideo();
    if (!video) return;

    const p = ncDescribeVideo(video);
    const { instant, ...rest } = extra;
    const payload = {
      user: ncUser.current,
      time: new Date().toISOString(),
      id: p.sourceId || 'unknown',
      url: p.sourceUrl || window.location?.href || '',
      rate: p.playbackRate ?? 1,
      paused: !ncIsPlaying(video),
      position_s: Number.isFinite(p.currentTimeS) ? p.currentTimeS : 0,
      duration_s: Number.isFinite(p.durationS) ? p.durationS : null,
      ready_state: p.readyState ?? -1,
      network: ncNetworkStateLabel(p.networkState),
      frames: p.frames ?? 0,
      dropped: p.dropped ?? 0,
      segment: (typeof ncSync !== 'undefined' && ncSync.currentSegment) || null,
      ...rest,
    };

    const send = async () => {
      try {
        await ncPost(NC_CONFIG.ENDPOINTS.TELEMETRY, payload);
      } catch {
        // Server offline; ignore.
      }
    };

    if (instant) {
      await send();
    } else {
      ncDeferredCall(send);
    }
  },

  start() {
    if (this.started) return;
    this.started = true;
    this.push();
    this.tickCallback = () => this.push();
    ncTicker.onSlowTick(this.tickCallback);
    console.log('[Netflix Connect] Telemetry started');
  },

  stop() {
    if (this.tickCallback) {
      ncTicker.off(this.tickCallback);
      this.tickCallback = null;
    }
    this.started = false;
  },
};

// Debounced/throttled action reporters used by click and keyboard handlers.
const ncDebouncedPush = {
  _slowTimer: null,
  _slowLastAction: null,
  slow(action) {
    this._slowLastAction = action;
    clearTimeout(this._slowTimer);
    this._slowTimer = setTimeout(() => {
      const actionToSend = this._slowLastAction;
      this._slowTimer = null;
      this._slowLastAction = null;
      ncDeferredCall(() => ncTelemetry.push({ action: actionToSend }));
    }, NC_CONFIG.SLOW_DEBOUNCE_MS);
  },

  _fastTimer: null,
  fast(action) {
    clearTimeout(this._fastTimer);
    this._fastTimer = setTimeout(() => {
      this._fastTimer = null;
      ncDeferredCall(() => ncTelemetry.push(action ? { action } : {}));
    }, NC_CONFIG.FAST_DEBOUNCE_MS);
  },

  _throttled: null,
  throttledSkip(action) {
    if (!this._throttled) {
      this._throttled = ncThrottle((a) => {
        ncDeferredCall(() => ncTelemetry.push({ action: a }));
      }, NC_CONFIG.THROTTLE_MS);
    }
    this._throttled(action);
  },
};
