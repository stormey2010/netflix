/**
 * Netflix Connect - Playback Sync
 *
 * Outbound: listens to the local video (play/pause/seek/rate), player-control
 * clicks, intro/recap segment presence, and tab visibility, and relays them
 * to the partner via POST /sync.
 *
 * Inbound: executes `command` channel events from the unified stream through
 * ncPlayer (soft rate-nudge for gaps <= 10s, hard seek beyond that).
 *
 * Also auto catch-up when behind, and a slower drift prompt when far ahead.
 */

const ncSync = {
  isPageUnloading: false,
  lastKnownTime: 0,
  lastPaused: true,
  lastPlaybackRate: 1.0,
  SEEK_DETECT_THRESHOLD_S: 1.0,

  // Current Netflix UI segment: null | 'intro' | 'recap'
  currentSegment: null,
  holdingForPartnerSegment: false,
  segmentPollId: null,

  SKIP_SELECTORS: {
    intro: 'button[data-uia="player-skip-intro"]',
    recap: 'button[data-uia="player-skip-recap"]',
    credits: 'button[data-uia="next-episode-seamless-button-credits"]',
  },

  // === Outbound ===========================================================

  async send(command, seconds, extra = {}) {
    if (!ncUser.current || this.isPageUnloading || !ncGetVideo()) return;
    const payload = {
      command,
      seconds: Math.floor(seconds),
      source_user: ncUser.current,
      ...extra,
    };
    console.log(`[Netflix Connect] Sync out: ${command} @ ${payload.seconds}s`, extra);
    try {
      await ncPost(NC_CONFIG.ENDPOINTS.SYNC, payload);
    } catch {
      // Server offline is expected; ignore.
    }
  },

  detectSegment() {
    if (document.querySelector(this.SKIP_SELECTORS.intro)) return 'intro';
    if (document.querySelector(this.SKIP_SELECTORS.recap)) return 'recap';
    return null;
  },

  setupSegmentWatcher() {
    if (this.segmentPollId) return;
    this.segmentPollId = setInterval(() => this.pollSegment(), NC_CONFIG.SEGMENT_POLL_MS);
    this.pollSegment();
  },

  pollSegment() {
    if (ncGetPageType() !== 'watch') {
      if (this.currentSegment) this.onSegmentChange(null);
      return;
    }
    const next = this.detectSegment();
    if (next !== this.currentSegment) this.onSegmentChange(next);
  },

  onSegmentChange(next) {
    const prev = this.currentSegment;
    this.currentSegment = next;
    const video = ncGetVideo();
    if (!video) return;

    if (next) {
      // We entered intro/recap — tell partner to pause and join us here.
      console.log(`[Netflix Connect] Entered ${next}`);
      this.send('sync_segment', video.currentTime, { segment: next });
      ncTelemetry.push({ action: `segment_${next}`, segment: next, instant: true });
      if (typeof ncNotifications !== 'undefined') {
        ncNotifications.showNote(
          next === 'intro' ? 'In intro — pausing partner to match' : 'In recap — pausing partner to match',
          2500
        );
      }
    } else if (prev) {
      // Left intro/recap without an explicit skip click (natural end).
      console.log(`[Netflix Connect] Left ${prev}`);
      this.send('sync_segment_clear', video.currentTime, { segment: prev });
      ncTelemetry.push({ action: `segment_clear_${prev}`, segment: null, instant: true });
    }
  },

  attachVideoListeners() {
    const video = ncGetVideo();
    if (!video || video.__ncListenersAttached) return;
    video.__ncListenersAttached = true;

    this.lastKnownTime = video.currentTime;
    this.lastPaused = video.paused;
    this.lastPlaybackRate = video.playbackRate;

    video.addEventListener('play', () => {
      ncTelemetry.push({ action: 'video_play', instant: true });
      if (ncPlayer.wasRemote('play')) {
        this.lastPaused = false;
        return;
      }
      if (this.holdingForPartnerSegment) return;
      if (this.lastPaused) this.send('sync_play', video.currentTime);
      this.lastPaused = false;
    });

    video.addEventListener('pause', () => {
      ncTelemetry.push({ action: 'video_pause', instant: true });
      if (ncPlayer.wasRemote('pause')) {
        this.lastPaused = true;
        return;
      }
      ncPlayer.cancelSoftSync();
      if (!this.lastPaused) this.send('sync_pause', video.currentTime);
      this.lastPaused = true;
    });

    video.addEventListener('seeked', () => {
      ncTelemetry.push({ action: 'video_seeked', instant: true });
      if (ncPlayer.wasRemote('seek')) {
        this.lastKnownTime = video.currentTime;
        return;
      }
      const jump = Math.abs(video.currentTime - this.lastKnownTime);
      if (jump > this.SEEK_DETECT_THRESHOLD_S) {
        ncPlayer.cancelSoftSync();
        this.send('sync_seek', video.currentTime);
      }
      this.lastKnownTime = video.currentTime;
    });

    video.addEventListener('timeupdate', () => {
      const jump = Math.abs(video.currentTime - this.lastKnownTime);
      if (jump > 2 && !ncPlayer.wasRemote('seek')) {
        this.send('sync_seek', video.currentTime);
      }
      this.lastKnownTime = video.currentTime;
    });

    video.addEventListener('ratechange', () => {
      ncDeferredCall(() => ncTelemetry.push({ action: 'video_ratechange' }));
      if (ncPlayer.wasRemote('rate')) {
        this.lastPlaybackRate = video.playbackRate;
        return;
      }
      if (video.playbackRate !== this.lastPlaybackRate) {
        this.send('sync_speed', video.currentTime, { playback_rate: video.playbackRate });
        this.lastPlaybackRate = video.playbackRate;
      }
    });

    console.log('[Netflix Connect] Video listeners attached');
  },

  tryAttachVideoListeners(attempts = 0) {
    if (ncGetVideo()) {
      this.attachVideoListeners();
      return;
    }
    if (attempts < 30) setTimeout(() => this.tryAttachVideoListeners(attempts + 1), 500);
  },

  setupClickListeners() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('button[data-uia="control-forward10"]')) {
        ncDebouncedPush.throttledSkip('forward10');
        return;
      }
      if (e.target.closest('button[data-uia="control-back10"]')) {
        ncDebouncedPush.throttledSkip('back10');
        return;
      }

      for (const [type, selector] of Object.entries(this.SKIP_SELECTORS)) {
        if (e.target.closest(selector)) {
          ncDebouncedPush.fast(`click_skip_${type}`);
          // Skip clears our segment; report the post-skip position shortly after.
          this.currentSegment = null;
          setTimeout(() => {
            const video = ncGetVideo();
            if (video) this.send('sync_skip', video.currentTime, { skip_type: type });
          }, 150);
          return;
        }
      }

      const simpleClicks = [
        ['button[data-uia="control-play-pause-play"], button[data-uia="control-play-pause-pause"]', 'click_playpause'],
        ['button[data-uia="control-mute-unmute-mute"], button[data-uia="control-mute-unmute-unmute"]', 'click_mute'],
        ['button[data-uia="control-fullscreen-enter"], button[data-uia="control-fullscreen-exit"]', 'click_fullscreen'],
        ['button[data-uia="next-episode-seamless-button"], button[data-uia="next-episode-seamless-button-draining"]', 'click_next_episode'],
      ];
      for (const [selector, action] of simpleClicks) {
        if (e.target.closest(selector)) {
          ncDebouncedPush.fast(action);
          return;
        }
      }
    }, true);
  },

  setupKeyboardListeners() {
    const KEY_ACTIONS = {
      ' ': 'key_space', Space: 'key_space',
      Enter: 'key_enter',
      m: 'key_mute', M: 'key_mute',
      f: 'key_fullscreen', F: 'key_fullscreen',
      Escape: 'key_escape',
      s: 'key_skip', S: 'key_skip',
    };
    const ARROWS = new Set(['ArrowLeft', 'Left', 'ArrowRight', 'Right', 'ArrowUp', 'Up', 'ArrowDown', 'Down']);

    document.addEventListener('keydown', (e) => {
      if (!ncGetVideo()) return;
      const key = e.key || e.code;
      if (ARROWS.has(key)) {
        ncDebouncedPush.slow('key_' + key.replace('Arrow', '').toLowerCase());
        return;
      }
      const action = KEY_ACTIONS[key];
      if (action) ncDebouncedPush.fast(action);
    }, true);
  },

  setupTabVisibility() {
    document.addEventListener('visibilitychange', () => {
      const video = ncGetVideo();
      if (document.hidden) {
        if (video && !video.paused) {
          ncPlayer.silentPause();
          this.send('sync_tab_away', video.currentTime);
          ncNotifications.showNote('Video paused (tab hidden)', 2000);
        }
      } else if (video) {
        this.send('sync_tab_back', video.currentTime);
      }
    });
  },

  // === Inbound ============================================================

  handleCommand(data) {
    const partner = data.source_user || 'Partner';
    const soft = data.soft !== false; // prefer soft unless explicitly false

    switch (data.command) {
      case 'play':
        ncPlayer.remotePlay();
        ncTelemetry.push({ action: 'dashboard_play', instant: true });
        break;
      case 'pause':
        ncPlayer.remotePause();
        ncTelemetry.push({ action: 'dashboard_pause', instant: true });
        break;
      case 'seek':
        if (Number.isFinite(data.seconds)) {
          ncPlayer.remoteSeek(data.seconds, { force: true });
          ncTelemetry.push({ action: 'dashboard_seek', instant: true });
        }
        break;

      // Dashboard / auto align — soft for small gaps, hard beyond.
      case 'sync_align':
      case 'align':
        if (!Number.isFinite(data.seconds)) break;
        if (soft) {
          const mode = ncPlayer.remoteSeek(data.seconds, { force: false, moving: true });
          if (mode === 'soft') {
            ncNotifications.showNote('Catching up…', 2000);
          } else if (mode === 'seek') {
            ncNotifications.showNote('Synced', 1500);
          }
        } else {
          ncPlayer.remoteSeek(data.seconds, { force: true });
          ncNotifications.showNote('Synced', 1500);
        }
        ncTelemetry.push({ action: 'sync_align_received', instant: true });
        break;

      case 'sync_play':
        this.holdingForPartnerSegment = false;
        if (ncPlayer.remotePlay(data.seconds)) {
          ncTelemetry.push({ action: 'sync_play_received' });
        }
        break;
      case 'sync_pause':
        if (ncPlayer.remotePause(data.seconds)) {
          ncTelemetry.push({ action: 'sync_pause_received' });
        }
        break;
      case 'sync_seek':
        if (ncPlayer.remoteSeek(data.seconds, { force: !soft })) {
          ncTelemetry.push({ action: 'sync_seek_received' });
        }
        break;
      case 'sync_speed':
        if (ncPlayer.remoteRate(data.playback_rate)) {
          ncNotifications.showNote(`Speed changed to ${data.playback_rate}x`, 2000);
          ncTelemetry.push({ action: 'sync_speed_received' });
        }
        break;
      case 'sync_skip':
        this.holdingForPartnerSegment = false;
        if (ncPlayer.remoteSeek(data.seconds, { force: true })) {
          const label = { intro: 'Skipped intro', recap: 'Skipped recap' }[data.skip_type] || 'Skipped credits';
          ncNotifications.showNote(`${label} (synced)`, 2000);
          ncTelemetry.push({ action: `sync_skip_${data.skip_type}_received` });
        }
        // Resume after skip so both keep watching.
        ncPlayer.remotePlay(data.seconds);
        break;

      // Partner is in intro/recap and we aren't — pause and join their position.
      case 'sync_segment': {
        const segment = data.segment || 'intro';
        const locallyInSame = this.detectSegment() === segment;
        if (locallyInSame) break;

        this.holdingForPartnerSegment = true;
        ncPlayer.remotePause(data.seconds);
        // Soft-align if close; otherwise hard seek back into the segment.
        ncPlayer.remoteSeek(data.seconds, { force: false, moving: false });
        const label = segment === 'intro' ? 'intro' : 'recap';
        ncNotifications.showNote(
          `${partner} is in the ${label} — paused to match`,
          3500
        );
        ncTelemetry.push({ action: `sync_segment_${segment}_hold`, instant: true });
        break;
      }

      case 'sync_segment_clear':
        if (this.holdingForPartnerSegment) {
          this.holdingForPartnerSegment = false;
          if (Number.isFinite(data.seconds)) {
            ncPlayer.remoteSeek(data.seconds, { force: false, moving: true });
          }
          ncPlayer.remotePlay(data.seconds);
          ncNotifications.showNote(`${partner} finished ${data.segment || 'segment'} — resuming`, 2500);
        }
        break;

      case 'sync_tab_away':
        ncPlayer.silentPause();
        ncNotifications.showNote(`${partner} stepped away`, 3000);
        break;
      case 'sync_tab_back':
        ncNotifications.showNote(`${partner} is back!`, 2000);
        break;
      case 'partner_left':
        ncNotifications.showNote(`${partner} stopped watching`, 3000);
        break;

      case 'share':
        if (data.url) ncNotifications.showShareReceived(partner, data.title || 'content', data.url);
        break;
      case 'watchlist_added':
        ncNotifications.showWatchlistChange('added', data.added_by, data.title);
        break;
      case 'watchlist_removed':
        ncNotifications.showWatchlistChange('removed', data.removed_by, data.title);
        break;
    }
  },

  init() {
    this.setupClickListeners();
    this.setupKeyboardListeners();
    this.tryAttachVideoListeners();
    this.setupTabVisibility();
    this.setupSegmentWatcher();

    window.addEventListener('beforeunload', () => {
      this.isPageUnloading = true;
    });

    ncStream.on('command', (data) => this.handleCommand(data));
  },
};


/**
 * Drift / catch-up helpers
 * - Frequent auto soft catch-up when we're behind by <= 10s
 * - Occasional prompt when we're far ahead
 */
const ncDriftChecker = {
  intervalId: null,
  catchupId: null,
  lastNotificationTime: 0,
  lastAutoCatchup: 0,

  start() {
    if (!this.intervalId) {
      this.intervalId = setInterval(() => this.checkAhead(), NC_CONFIG.DRIFT_CHECK_INTERVAL_MS);
    }
    if (!this.catchupId) {
      this.catchupId = setInterval(() => this.checkBehind(), NC_CONFIG.CATCHUP_CHECK_INTERVAL_MS);
    }
  },

  stop() {
    clearInterval(this.intervalId);
    clearInterval(this.catchupId);
    this.intervalId = null;
    this.catchupId = null;
  },

  async _fetchDrift() {
    if (!ncUser.current || ncUser.current === 'unknown') return null;
    if (ncGetPageType() !== 'watch') return null;
    if (ncPlayer.softSyncActive()) return null;
    try {
      return await ncGet(
        `${NC_CONFIG.ENDPOINTS.SYNC_DRIFT}?user=${encodeURIComponent(ncUser.current)}`
      );
    } catch {
      return null;
    }
  },

  async checkBehind() {
    const data = await this._fetchDrift();
    if (!data || data.status !== 'behind') return;
    if (data.my_paused || data.their_paused) return;
    if (ncSync.holdingForPartnerSegment || ncSync.currentSegment) return;

    const gap = Math.abs(data.drift);
    if (gap < NC_CONFIG.SOFT_SYNC_MIN_S) return;
    if (gap > NC_CONFIG.SOFT_SYNC_MAX_S) return; // leave big gaps to the ahead prompt / dashboard

    const now = Date.now();
    if (now - this.lastAutoCatchup < NC_CONFIG.CATCHUP_CHECK_INTERVAL_MS) return;
    this.lastAutoCatchup = now;

    console.log(`[Netflix Connect] Auto catch-up: ${gap.toFixed(1)}s behind`);
    ncPlayer.remoteSeek(data.sync_to, { force: false, moving: !data.their_paused });
  },

  async checkAhead() {
    const data = await this._fetchDrift();
    if (!data || data.status !== 'ahead' || data.drift <= NC_CONFIG.DRIFT_THRESHOLD_S) return;

    const now = Date.now();
    if (now - this.lastNotificationTime < NC_CONFIG.DRIFT_CHECK_INTERVAL_MS) return;
    this.lastNotificationTime = now;
    this.notify(data);
  },

  notify(data) {
    const syncTo = data.sync_to;
    const mins = Math.floor(syncTo / 60);
    const secs = String(syncTo % 60).padStart(2, '0');
    const soft = Math.abs(data.drift) <= NC_CONFIG.SOFT_SYNC_MAX_S;

    ncNotifications.show({
      type: 'sync',
      title: `You're ${Math.round(data.drift)}s ahead`,
      message: soft
        ? `${data.partner} is at ${mins}:${secs}. Ease back?`
        : `${data.partner} is at ${mins}:${secs}. Sync up?`,
      duration: 0,
      actions: [
        {
          label: soft ? 'Catch up' : 'Sync Now',
          primary: true,
          action: () => {
            ncPlayer.remoteSeek(syncTo, { force: !soft, moving: !data.their_paused });
          },
        },
        { label: 'Ignore', primary: false, action: () => {} },
      ],
    });
  },
};
