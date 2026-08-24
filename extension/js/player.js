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

  // Suppress every action kind so Netflix's internal pause/play around a
  // remote seek cannot bounce back to the partner.
  _markAll(ms = NC_CONFIG.REMOTE_SUPPRESS_MS) {
    const until = Date.now() + ms;
    for (const k of Object.keys(this._suppressedUntil)) {
      this._suppressedUntil[k] = Math.max(this._suppressedUntil[k] || 0, until);
    }
  },

  // True if an event of this kind was likely caused by a remote action we
  // just applied (and therefore must not be echoed back to the partner).
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

  // Raw seek through the Netflix player API (page context).
  _dispatchSeek(seconds) {
    window.dispatchEvent(new CustomEvent('np-seek', { detail: { ms: Number(seconds) * 1000 } }));
  },

  _hardSeek(seconds) {
    this._markAll(NC_CONFIG.REMOTE_SEEK_SUPPRESS_MS);
    this._dispatchSeek(seconds);
  },

  // === Soft sync (rate nudging) ===========================================

  _soft: {
    active: false,
    timer: null,
    baseRate: 1,
    anchorPos: 0,     // partner position at the moment the sync arrived
    anchorAt: 0,      // Date.now() when the sync arrived
    moving: true,     // whether the partner's position advances over time
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

    // Restore any previous nudge first so we capture the true base rate.
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

    // Abort if the video vanished, was paused, or we've been at it too long.
    if (!v || v.paused || Date.now() - s.startedAt > NC_CONFIG.SOFT_SYNC_TIMEOUT_MS) {
      this.cancelSoftSync();
      return;
    }

    // Freeze the moving target while buffering/seeking so the gap does not
    // inflate into a hard-seek jump.
    if (v.readyState < 2 || v.seeking) {
      if (s.moving) {
        const target = this._softTarget();
        s.anchorPos = target;
        s.anchorAt = Date.now();
      }
      return;
    }

    const drift = this._softTarget() - v.currentTime; // positive = we're behind

    if (drift <= NC_CONFIG.SOFT_SYNC_DONE_S) {
      this.cancelSoftSync();
      if (typeof ncNotifications !== 'undefined') {
        ncNotifications.showNote('In sync with partner', 1500);
      }
      return;
    }

    // If the gap grew past the soft window (user seek), hard seek.
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
      // Keep the suppression window open while we hold a non-base rate.
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

  // === Sync entry point ====================================================

  /**
   * Align our playback with a partner position.
   * - tiny drift: do nothing
   * - small drift while playing: soft sync (rate nudge)
   * - large drift, paused, or force: hard seek
   * Returns 'soft', 'seek', 'queued', or false if no correction was needed/possible.
   */
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

    const drift = seconds - v.currentTime; // positive means this client is behind
    if (Math.abs(drift) <= NC_CONFIG.SOFT_SYNC_MIN_S) return false;

    if (drift > 0 && drift < NC_CONFIG.SOFT_SYNC_MAX_S && !v.paused && moving) {
      return this._startSoftSync(seconds, { moving }) ? 'soft' : false;
    }

    this.cancelSoftSync({ restoreRate: true });
    this._hardSeek(seconds);
    return 'seek';
  },

  // === Remote actions (from partner sync / dashboard commands) ===

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
      v.play().then(() => {
        if (seconds !== null && this.isReady()) {
          this.syncTo(seconds, { force: false, moving: true });
        }
      }).catch(() => {});
    };
    tryPlay();
    // Netflix sometimes ignores the first play() while the player is settling.
    setTimeout(() => {
      if (v.paused && this.wasRemote('play')) tryPlay();
    }, 120);
    return true;
  },

  remotePause(seconds = null) {
    const v = this.video();
    if (!v) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._markAll(NC_CONFIG.REMOTE_SUPPRESS_MS);
    this._mark('pause');
    const forcePause = () => {
      try { v.pause(); } catch {}
    };
    forcePause();
    // Don't require readyState — pause must work even while buffering.
    // Netflix occasionally resumes after an external pause; nudge twice.
    setTimeout(() => {
      if (v && !v.paused && this.wasRemote('pause')) forcePause();
    }, 50);
    setTimeout(() => {
      if (v && !v.paused && this.wasRemote('pause')) forcePause();
    }, 200);
    if (seconds !== null && seconds >= 0) {
      if (this.isReady()) {
        const drift = Math.abs(v.currentTime - seconds);
        if (drift > NC_CONFIG.EXACT_SYNC_THRESHOLD_S) this._hardSeek(seconds);
      } else {
        this._queuePending(seconds, { force: true, moving: false });
      }
    }
    return true;
  },

  remoteSeek(seconds, { force = false, moving = true } = {}) {
    return this.syncTo(seconds, { force, moving });
  },

  remoteRate(rate) {
    const v = this.video();
    if (!v || !rate) return false;
    // Partner's intentional speed change becomes our new base rate.
    this._soft.baseRate = rate;
    if (this._soft.active) return true; // soft sync will converge onto it
    if (v.playbackRate === rate) return false;
    this._mark('rate');
    v.playbackRate = rate;
    return true;
  },

  // Local pause that should not be treated as a user action (tab hidden).
  silentPause() {
    const v = this.video();
    if (!v || v.paused) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._mark('pause');
    v.pause();
    return true;
  },
};
