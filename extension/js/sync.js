/**
 * Netflix Connect - Playback Sync
 *
 * Outbound: listens to the local video (play/pause/seek/rate), player-control
 * clicks, and tab visibility, and relays them to the partner via POST /sync.
 *
 * Inbound: executes `command` channel events from the unified stream through
 * ncPlayer, which handles echo suppression.
 *
 * Also runs the periodic drift check.
 */

const ncSync = {
  isPageUnloading: false,
  lastKnownTime: 0,
  lastPaused: true,
  lastPlaybackRate: 1.0,
  SEEK_DETECT_THRESHOLD_S: 1.0,

  // === Outbound ===========================================================

  async send(command, seconds, extra = {}) {
    if (!ncUser.current || this.isPageUnloading || !ncGetVideo()) return;
    const payload = {
      command,
      seconds: Math.floor(seconds),
      source_user: ncUser.current,
      ...extra,
    };
    console.log(`[Netflix Connect] Sync out: ${command} @ ${payload.seconds}s`);
    try {
      await ncPost(NC_CONFIG.ENDPOINTS.SYNC, payload);
    } catch {
      // Server offline is expected; ignore.
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
        // A deliberate local seek overrides any in-progress soft sync.
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
    const SKIP_SELECTORS = {
      intro: 'button[data-uia="player-skip-intro"]',
      recap: 'button[data-uia="player-skip-recap"]',
      credits: 'button[data-uia="next-episode-seamless-button-credits"]',
    };

    document.addEventListener('click', (e) => {
      if (e.target.closest('button[data-uia="control-forward10"]')) {
        ncDebouncedPush.throttledSkip('forward10');
        return;
      }
      if (e.target.closest('button[data-uia="control-back10"]')) {
        ncDebouncedPush.throttledSkip('back10');
        return;
      }

      for (const [type, selector] of Object.entries(SKIP_SELECTORS)) {
        if (e.target.closest(selector)) {
          ncDebouncedPush.fast(`click_skip_${type}`);
          // Report position shortly after Netflix applies the skip.
          setTimeout(() => {
            const video = ncGetVideo();
            if (video) this.send('sync_skip', video.currentTime, { skip_type: type });
          }, 100);
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
      ' ': 'key_space', 'Space': 'key_space',
      'Enter': 'key_enter',
      'm': 'key_mute', 'M': 'key_mute',
      'f': 'key_fullscreen', 'F': 'key_fullscreen',
      'Escape': 'key_escape',
      's': 'key_skip', 'S': 'key_skip',
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

    switch (data.command) {
      // Dashboard commands
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

      // Partner sync
      case 'sync_play':
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
        if (ncPlayer.remoteSeek(data.seconds)) {
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
        if (ncPlayer.remoteSeek(data.seconds, { force: true })) {
          const label = { intro: 'Skipped intro', recap: 'Skipped recap' }[data.skip_type] || 'Skipped credits';
          ncNotifications.showNote(`${label} (synced)`, 2000);
          ncTelemetry.push({ action: `sync_skip_${data.skip_type}_received` });
        }
        break;

      // Presence
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

      // Social
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

  // === Init ===============================================================

  init() {
    this.setupClickListeners();
    this.setupKeyboardListeners();
    this.tryAttachVideoListeners();
    this.setupTabVisibility();

    window.addEventListener('beforeunload', () => {
      this.isPageUnloading = true;
    });

    ncStream.on('command', (data) => this.handleCommand(data));
  },
};


/**
 * Drift checker - periodically asks the server whether we've drifted ahead of
 * our partner and offers a one-click resync.
 */
const ncDriftChecker = {
  intervalId: null,
  lastNotificationTime: 0,

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.check(), NC_CONFIG.DRIFT_CHECK_INTERVAL_MS);
  },

  stop() {
    clearInterval(this.intervalId);
    this.intervalId = null;
  },

  async check() {
    if (!ncUser.current || ncUser.current === 'unknown') return;
    if (ncGetPageType() !== 'watch') return;

    try {
      const data = await ncGet(`${NC_CONFIG.ENDPOINTS.SYNC_DRIFT}?user=${encodeURIComponent(ncUser.current)}`);
      if (data.status !== 'ahead' || data.drift <= NC_CONFIG.DRIFT_THRESHOLD_S) return;

      const now = Date.now();
      if (now - this.lastNotificationTime < NC_CONFIG.DRIFT_CHECK_INTERVAL_MS) return;
      this.lastNotificationTime = now;
      this.notify(data);
    } catch {
      // Server offline; ignore.
    }
  },

  notify(data) {
    const syncTo = data.sync_to;
    const mins = Math.floor(syncTo / 60);
    const secs = String(syncTo % 60).padStart(2, '0');

    ncNotifications.show({
      type: 'sync',
      title: `You're ${Math.round(data.drift)}s ahead`,
      message: `${data.partner} is at ${mins}:${secs}. Sync up?`,
      duration: 0,
      actions: [
        { label: 'Sync Now', primary: true, action: () => {
          // Small gaps ease back via a gentle rate nudge; big gaps hard seek.
          ncPlayer.remoteSeek(syncTo, { moving: !data.their_paused });
        } },
        { label: 'Ignore', primary: false, action: () => {} },
      ],
    });
  },
};
