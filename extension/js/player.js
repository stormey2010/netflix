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
 * slightly faster (or slightly slower if ahead) until perfectly aligned, then
 * the original speed is restored.
 */

const ncPlayer = {
  _suppressedUntil: { play: 0, pause: 0, seek: 0, rate: 0 },

  _mark(kind) {
    this._suppressedUntil[kind] = Date.now() + NC_CONFIG.REMOTE_SUPPRESS_MS;
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

  // Raw seek through the Netflix player API (page context).
  _dispatchSeek(seconds) {
    window.dispatchEvent(new CustomEvent('np-seek', { detail: { ms: Number(seconds) * 1000 } }));
  },

  _hardSeek(seconds) {
    this._mark('seek');
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

    const behind = this._softTarget() > v.currentTime;
    console.log(`[Netflix Connect] Soft sync started (${behind ? 'speeding up' : 'slowing down'})`);
    if (typeof ncNotifications !== 'undefined') {
      ncNotifications.showNote(behind ? 'Catching up to partner…' : 'Easing back to partner…', 2000);
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

    const drift = this._softTarget() - v.currentTime; // positive = we're behind

    if (Math.abs(drift) <= NC_CONFIG.SOFT_SYNC_DONE_S) {
      this.cancelSoftSync();
      if (typeof ncNotifications !== 'undefined') {
        ncNotifications.showNote('In sync with partner', 1500);
      }
      return;
    }

    // If the gap grew past the soft window (buffering, user seek), hard seek.
    if (Math.abs(drift) > NC_CONFIG.SOFT_SYNC_MAX_S + 2) {
      const target = this._softTarget();
      this.cancelSoftSync();
      this._hardSeek(target);
      return;
    }

    // Gentle proportional adjustment, capped so it stays subtle.
    const adjust = Math.sign(drift) * Math.min(
      NC_CONFIG.SOFT_SYNC_MAX_ADJUST,
      Math.max(0.08, Math.abs(drift) / 12)
    );
    const rate = Math.max(0.5, s.baseRate + adjust);
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
   * Returns 'soft', 'seek', or false if no correction was needed/possible.
   */
  syncTo(seconds, { force = false, moving = true } = {}) {
    const v = this.video();
    if (!v || !this.isReady() || !Number.isFinite(seconds)) return false;

    if (force) {
      this.cancelSoftSync({ restoreRate: true });
      this._hardSeek(seconds);
      return 'seek';
    }

    const drift = Math.abs(v.currentTime - seconds);
    if (drift <= NC_CONFIG.SOFT_SYNC_MIN_S) return false;

    if (drift <= NC_CONFIG.SOFT_SYNC_MAX_S && !v.paused) {
      return this._startSoftSync(seconds, { moving }) ? 'soft' : false;
    }

    this.cancelSoftSync({ restoreRate: true });
    this._hardSeek(seconds);
    return 'seek';
  },

  // === Remote actions (from partner sync / dashboard commands) ===

  remotePlay(seconds = null) {
    const v = this.video();
    if (!v || !this.isReady()) return false;
    this._mark('play');
    v.play().catch(() => {});
    if (seconds !== null) this.syncTo(seconds, { moving: true });
    return true;
  },

  remotePause(seconds = null) {
    const v = this.video();
    if (!v || !this.isReady()) return false;
    this.cancelSoftSync({ restoreRate: true });
    this._mark('pause');
    v.pause();
    // Can't rate-nudge while paused; hard-align if meaningfully off.
    if (seconds !== null && seconds > 0) {
      const drift = Math.abs(v.currentTime - seconds);
      if (drift > NC_CONFIG.SEEK_APPLY_THRESHOLD_S) this._hardSeek(seconds);
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
