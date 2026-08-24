/**
 * Netflix Connect - Player Controller
 *
 * Single owner of playback control. All remote (partner/dashboard initiated)
 * actions go through here so that echo suppression is handled in one place:
 * applying a remote action opens a short suppression window per action type,
 * and the outbound sync listeners check `wasRemote()` before re-broadcasting.
 *
 * Seeking uses the page-bridge hook into Netflix's own player API
 * (a plain `video.currentTime =` assignment does not work on Netflix).
 *
 * Small drifts (<= SOFT_SYNC_MAX_S) are corrected with a gentle playback-rate
 * nudge ("soft sync") instead of a jarring hard seek: whoever is behind plays
 * at 1.25x until aligned. A client that is ahead seeks back immediately.
 */

const ncPlayer = {
  _suppressedUntil: { play: 0, pause: 0, seek: 0, rate: 0 },
  _pending: null,

  _mark(kind) {
    const duration = kind === 'seek'
      ? NC_CONFIG.REMOTE_SEEK_SUPPRESS_MS
      : NC_CONFIG.REMOTE_SUPPRESS_MS;
    this._suppressedUntil[kind] = Date.now() + duration;
  },

  _markAll(ms = NC_CONFIG.REMOTE_SUPPRESS_MS) {
    const until = Date.now() + ms;
    for (const k of Object.keys(this._suppressedUntil)) {
      this._suppressedUntil[k] = Math.max(this._suppressedUntil[k] || 0, until);
    }
  },

  wasRemote(kind) {
    return Date.now() < (this._suppressedUntil[kind] || 0);
  },

  video() {
    return ncGetVideo();
  },

  isReady() {
    const v = this.video();
    return !!v && v.readyState >= 2;
  },

  _queuePending(seconds, opts) {
    this._pending = { seconds, opts, at: Date.now() };
    const v = this.video();
    if (!v) return;
    const flush = () => this._flushPending();
    v.addEventListener('canplay', flush, { once: true });
    v.addEventListener('loadeddata', flush, { once: true });
  },

  _flushPending() {
    const p = this._pending;
    if (!p) return;
    if (Date.now() - p.at > 15000) {
      this._pending = null;
      return;
    }
    if (!this.isReady()) return;
    this._pending = null;
    this.syncTo(p.seconds, p.opts);
  },

  _dispatchSeek(seconds) {
    window.dispatchEvent(new CustomEvent('np-seek', { detail: { ms: Number(seconds) * 1000 } }));
  },

  _dispatchPlay() {
    window.dispatchEvent(new CustomEvent('np-play'));
  },

  _dispatchPause() {
    window.dispatchEvent(new CustomEvent('np-pause'));
  },

  _hardSeek(seconds) {
    this._markAll(NC_CONFIG.REMOTE_SEEK_SUPPRESS_MS);
    this._dispatchSeek(seconds);
  },

  _soft: {
    active: false,
    timer: null,
    baseRate: 1,
    anchorPos: 0,
    anchorAt: 0,
    moving: true,
    startedAt: 0,
  },

  _softTarget() {
    const s = this._soft;
    if (!s.moving) return s.anchorPos;
    return s.anchorPos + (Date.now() - s.anchorAt) / 1000;
  },

  softSyncActive() {
    return this._soft.active;
  },

  _startSoftSync(targetSeconds, { moving = true } = {}) {
    const v = this.video();
    if (!v) return false;

    this.cancelSoftSync({ restoreRate: true });
    const s = this._soft;
    s.active = true;
    s.baseRate = v.playbackRate;
    s.anchorPos = targetSeconds;
    s.anchorAt = Date.now();
    s.moving = moving;
    s.startedAt = Date.now();

    console.log(`[Netflix Connect] Catch-up started at ${NC_CONFIG.SOFT_SYNC_CATCHUP_RATE}x`);
    if (typeof ncNotifications !== 'undefined') {
      ncNotifications.showNote(`Catching up at ${NC_CONFIG.SOFT_SYNC_CATCHUP_RATE}x…`, 2000);
    }

    s.timer = setInterval(() => this._softSyncTick(), NC_CONFIG.SOFT_SYNC_TICK_MS);
    this._softSyncTick();
    return true;
  },

  _softSyncTick() {
    const s = this._soft;
    const v = this.video();

    if (!v || v.paused || Date.now() - s.startedAt > NC_CONFIG.SOFT_SYNC_TIMEOUT_MS) {
      this.cancelSoftSync();
      return;
    }

    if (v.readyState < 2 || v.seeking) {
      if (s.moving) {
        const target = this._softTarget();
        s.anchorPos = target;
        s.anchorAt = Date.now();
      }
      return;
    }

    const drift = this._softTarget() - v.currentTime;

    if (drift <= NC_CONFIG.SOFT_SYNC_DONE_S) {
      this.cancelSoftSync();
      if (typeof ncNotifications !== 'undefined') {
        ncNotifications.showNote('In sync with partner', 1500);
      }
      return;
    }

    if (drift > NC_CONFIG.SOFT_SYNC_MAX_S) {
      const target = this._softTarget();
      this.cancelSoftSync();
      this._hardSeek(target);
      return;
    }

    const rate = NC_CONFIG.SOFT_SYNC_CATCHUP_RATE;
    if (v.playbackRate !== rate) {
      this._mark('rate');
      v.playbackRate = rate;
    } else {
      this._mark('rate');
    }
  },

  cancelSoftSync({ restoreRate = true } = {}) {
    const s = this._soft;
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
    if (s.active && restoreRate) {
      const v = this.video();
      if (v && v.playbackRate !== s.baseRate) {
        this._mark('rate');
        v.playbackRate = s.baseRate;
      }
    }
    s.active = false;
  },

  syncTo(seconds, { force = false, moving = true } = {}) {
    const v = this.video();
    if (!v || !Number.isFinite(seconds)) return false;
    if (!this.isReady()) {
      this._queuePending(seconds, { force, moving });
      return 'queued';
    }

    if (force) {
      this.cancelSoftSync({ restoreRate: true });
      this._hardSeek(seconds);
      return 'seek';
    }

    const drift = seconds - v.currentTime;
    if (Math.abs(drift) <= NC_CONFIG.SOFT_SYNC_MIN_S) return false;

    if (drift > 0 && drift < NC_CONFIG.SOFT_SYNC_MAX_S && !v.paused && moving) {
      return this._startSoftSync(seconds, { moving }) ? 'soft' : false;
    }

    this.cancelSoftSync({ restoreRate: true });
    this._hardSeek(seconds);
    return 'seek';
  },

  _forcePause() {
    this._dispatchPause();
    const v = this.video();
    if (v) {
      try { v.pause(); } catch {}
    }
  },

  _forcePlay() {
    this._dispatchPlay();
    const v = this.video();
    if (v) {
      v.play().catch(() => {});
    }
  },

  /** Re-pause after Netflix ignores a user pause (no remote suppress needed). */
  enforcePause() {
    this.cancelSoftSync({ restoreRate: true });
    this._forcePause();
    const v = this.video();
    if (!v) return;
    setTimeout(() => { if (!v.paused) this._forcePause(); }, 50);
    setTimeout(() => { if (!v.paused) this._forcePause(); }, 200);
  },

  remotePlay(seconds = null) {
    const v = this.video();
    if (!v) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._markAll(NC_CONFIG.REMOTE_SUPPRESS_MS);
    if (seconds !== null && this.isReady() && seconds - v.currentTime >= NC_CONFIG.SOFT_SYNC_MAX_S) {
      this.syncTo(seconds, { force: true, moving: true });
    } else if (seconds !== null && !this.isReady()) {
      this._queuePending(seconds, { force: false, moving: true });
    }
    this._mark('play');
    const tryPlay = () => {
      this._forcePlay();
      if (seconds !== null && this.isReady()) {
        this.syncTo(seconds, { force: false, moving: true });
      }
    };
    tryPlay();
    setTimeout(() => {
      if (v.paused && this.wasRemote('play')) tryPlay();
    }, 120);
    setTimeout(() => {
      if (v.paused && this.wasRemote('play')) tryPlay();
    }, 400);
    return true;
  },

  remotePause(seconds = null) {
    const v = this.video();
    if (!v) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._markAll(NC_CONFIG.REMOTE_SUPPRESS_MS);
    this._mark('pause');

    // Seeking after pause makes Netflix resume — skip position nudge while paused.
    this._forcePause();
    const rePause = () => {
      if (v && !v.paused && this.wasRemote('pause')) this._forcePause();
    };
    setTimeout(rePause, 50);
    setTimeout(rePause, 200);
    setTimeout(rePause, 500);
    setTimeout(rePause, 1000);
    return true;
  },

  remoteSeek(seconds, { force = false, moving = true } = {}) {
    return this.syncTo(seconds, { force, moving });
  },

  remoteRate(rate) {
    const v = this.video();
    if (!v || !rate) return false;
    this._soft.baseRate = rate;
    if (this._soft.active) return true;
    if (v.playbackRate === rate) return false;
    this._mark('rate');
    v.playbackRate = rate;
    return true;
  },

  silentPause() {
    const v = this.video();
    if (!v || v.paused) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._mark('pause');
    this._forcePause();
    return true;
  },
};
