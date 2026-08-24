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
  sessionEnabled: false,
  lastKnownTime: 0,
  lastPaused: true,
  lastPlaybackRate: 1.0,
  lastSeqByStream: new Map(),
  seenEventIds: new Set(),
  lastOutbound: null,
  _lastCriticalKey: null,
  _lastCriticalAt: 0,
  _attachedVideo: null,
  _videoObserver: null,
  SEEK_DETECT_THRESHOLD_S: 1.0,
  seekInProgress: false,
  seekIntentUntil: 0,
  seekPlaybackWasPaused: true,
  resumeOnTabReturn: false,
  resumeAfterPartnerReturn: false,

  // Current Netflix UI segment: null | 'intro' | 'recap'
  currentSegment: null,
  holdingForPartnerSegment: false,
  segmentPollId: null,

  SKIP_SELECTORS: {
    intro: 'button[data-uia="player-skip-intro"]',
    recap: 'button[data-uia="player-skip-recap"]',
    credits: 'button[data-uia="next-episode-seamless-button-credits"]',
  },

  setEnabled(on) {
    this.sessionEnabled = !!on;
    if (!on) {
      this.holdingForPartnerSegment = false;
      this.currentSegment = null;
      if (this.segmentPollId) {
        clearInterval(this.segmentPollId);
        this.segmentPollId = null;
      }
      if (this._videoObserver) {
        this._videoObserver.disconnect();
        this._videoObserver = null;
      }
      this._attachedVideo = null;
      try { ncPlayer.cancelSoftSync?.({ restoreRate: true }); } catch {}
    } else {
      this.setupSegmentWatcher();
      this.tryAttachVideoListeners();
      this.ensureVideoObserver();
    }
  },

  // === Outbound ===========================================================

  async send(command, seconds, extra = {}) {
    if (!this.sessionEnabled) return;
    const video = ncGetVideo();
    if (!ncUser.current || this.isPageUnloading || !video) return;
    const payload = {
      command,
      seconds: Math.round(Number(seconds) * 1000) / 1000,
      source_user: ncUser.current,
      paused: video.paused,
      rate: video.playbackRate,
      ...extra,
    };
    const now = Date.now();
    const critical = command === 'sync_play' || command === 'sync_pause';
    const reliable = critical || command === 'sync_seek' || command === 'sync_skip';
    // Never debounce play/pause — rapid toggles must both land.
    if (
      !critical &&
      this.lastOutbound?.command === command &&
      now - this.lastOutbound.at < 300 &&
      Math.abs(this.lastOutbound.seconds - payload.seconds) < 0.5
    ) {
      return;
    }
    this.lastOutbound = { command, seconds: payload.seconds, at: now };
    console.log(`[Netflix Connect] Sync out: ${command} @ ${payload.seconds}s`, extra);

    // One event_id for WS + HTTP so the partner dedupes dual delivery.
    const envelope = ncStream.wrapSync(payload);
    const viaWs = ncStream.sendSync(envelope);
    if (viaWs && !reliable) return;
    try {
      await ncPost(NC_CONFIG.ENDPOINTS.SYNC, envelope);
    } catch {
      // Server offline is expected; ignore.
    }
  },

  detectSegment() {
    if (document.querySelector(this.SKIP_SELECTORS.intro)) return 'intro';
    if (document.querySelector(this.SKIP_SELECTORS.recap)) return 'recap';
    return null;
  },

  markSeekIntent(durationMs = 1200) {
    const video = ncGetVideo();
    if (!this.seekInProgress && Date.now() >= this.seekIntentUntil) {
      this.seekPlaybackWasPaused = video ? video.paused : this.lastPaused;
    }
    this.seekIntentUntil = Math.max(this.seekIntentUntil, Date.now() + durationMs);
  },

  isSeekTransition(video) {
    return this.seekInProgress || video?.seeking || Date.now() < this.seekIntentUntil;
  },

  setupSegmentWatcher() {
    if (this.segmentPollId) return;
    this.segmentPollId = setInterval(() => this.pollSegment(), NC_CONFIG.SEGMENT_POLL_MS);
    this.pollSegment();
  },

  pollSegment() {
    if (!this.sessionEnabled) return;
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
      // We entered intro/recap — align the partner while preserving play state.
      console.log(`[Netflix Connect] Entered ${next}`);
      this.send('sync_segment', video.currentTime, { segment: next });
      ncTelemetry.push({ action: `segment_${next}`, segment: next, instant: true });
      if (typeof ncNotifications !== 'undefined') {
        ncNotifications.showNote(
          next === 'intro' ? 'In intro — aligning partner' : 'In recap — aligning partner',
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

  ensureVideoObserver() {
    if (this._videoObserver || !this.sessionEnabled) return;
    this._videoObserver = new MutationObserver(() => {
      if (!this.sessionEnabled) return;
      const v = ncGetVideo();
      if (v && v !== this._attachedVideo) this.attachVideoListeners();
    });
    this._videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  },

  attachVideoListeners() {
    const video = ncGetVideo();
    if (!video) return;
    if (this._attachedVideo === video) return;
    this._attachedVideo = video;

    this.lastKnownTime = video.currentTime;
    this.lastPaused = video.paused;
    this.lastPlaybackRate = video.playbackRate;

    video.addEventListener('play', () => {
      if (!this.sessionEnabled) return;
      ncTelemetry.push({ action: 'video_play', instant: true });
      if (ncPlayer.wasRemote('play')) {
        this.lastPaused = false;
        return;
      }
      // Always broadcast — do not drop during seek transitions (Netflix often
      // pauses/plays around seeks and we were swallowing the real user action).
      this.holdingForPartnerSegment = false;
      this.send('sync_play', video.currentTime);
      this.lastPaused = false;
    });

    video.addEventListener('pause', () => {
      if (!this.sessionEnabled) return;
      ncTelemetry.push({ action: 'video_pause', instant: true });
      if (ncPlayer.wasRemote('pause')) {
        this.lastPaused = true;
        return;
      }
      // Partner tab-away was holding us; a real local pause means don't auto-resume.
      this.resumeAfterPartnerReturn = false;
      ncPlayer.cancelSoftSync();
      this.send('sync_pause', video.currentTime);
      this.lastPaused = true;
    });

    video.addEventListener('seeking', () => {
      this.markSeekIntent(1200);
      this.seekInProgress = true;
    });

    video.addEventListener('seeked', () => {
      this.seekInProgress = false;
      this.seekIntentUntil = Date.now() + 500;
      ncTelemetry.push({ action: 'video_seeked', instant: true });
      if (ncPlayer.wasRemote('seek')) {
        this.lastKnownTime = video.currentTime;
        return;
      }
      const jump = Math.abs(video.currentTime - this.lastKnownTime);
      if (jump > this.SEEK_DETECT_THRESHOLD_S) {
        ncPlayer.cancelSoftSync();
        this.send('sync_seek', video.currentTime, { paused: this.seekPlaybackWasPaused });
      }
      this.lastKnownTime = video.currentTime;
      setTimeout(() => {
        if (!this.isSeekTransition(video)) this.lastPaused = video.paused;
      }, 550);
    });

    video.addEventListener('timeupdate', () => {
      if (this.isSeekTransition(video) || ncPlayer.wasRemote('seek')) {
        this.lastKnownTime = video.currentTime;
        return;
      }
      const jump = Math.abs(video.currentTime - this.lastKnownTime);
      if (jump > 2) {
        this.send('sync_seek', video.currentTime, { paused: this.seekPlaybackWasPaused });
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
      this.ensureVideoObserver();
      return;
    }
    if (attempts < 30) setTimeout(() => this.tryAttachVideoListeners(attempts + 1), 500);
  },

  setupClickListeners() {
    document.addEventListener('pointerdown', (e) => {
      if (!this.sessionEnabled) return;
      if (e.target.closest('[role="slider"], [data-uia*="timeline"], [data-uia*="progress"]')) {
        this.markSeekIntent(1600);
      }
    }, true);

    document.addEventListener('click', (e) => {
      if (!this.sessionEnabled) return;
      if (e.target.closest('button[data-uia="control-forward10"]')) {
        this.markSeekIntent();
        ncDebouncedPush.throttledSkip('forward10');
        return;
      }
      if (e.target.closest('button[data-uia="control-back10"]')) {
        this.markSeekIntent();
        ncDebouncedPush.throttledSkip('back10');
        return;
      }

      for (const [type, selector] of Object.entries(this.SKIP_SELECTORS)) {
        if (e.target.closest(selector)) {
          this.markSeekIntent(1800);
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
          if (action === 'click_playpause') this.verifyPlayPauseAfterControl();
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
      if (!this.sessionEnabled) return;
      if (!ncGetVideo()) return;
      const key = e.key || e.code;
      if (ARROWS.has(key)) {
        this.markSeekIntent();
        ncDebouncedPush.slow('key_' + key.replace('Arrow', '').toLowerCase());
        return;
      }
      const action = KEY_ACTIONS[key];
      if (action) {
        ncDebouncedPush.fast(action);
        if (action === 'key_space' || action === 'key_enter') {
          this.verifyPlayPauseAfterControl();
        }
      }
    }, true);
  },

  // Netflix occasionally changes state through its internal player before a
  // reliable media event reaches the content script. Verify the state after
  // every play/pause control and relay any transition the media event missed.
  verifyPlayPauseAfterControl() {
    const check = () => {
      if (!this.sessionEnabled) return;
      const video = ncGetVideo();
      if (!video || video.paused === this.lastPaused) return;
      const command = video.paused ? 'sync_pause' : 'sync_play';
      this.lastPaused = video.paused;
      if (video.paused) {
        this.resumeAfterPartnerReturn = false;
        ncPlayer.cancelSoftSync();
      }
      this.send(command, video.currentTime);
    };
    // Netflix often flips state a few frames after the click.
    setTimeout(check, 40);
    setTimeout(check, 160);
  },

  setupTabVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (!this.sessionEnabled) return;
      const video = ncGetVideo();
      if (document.hidden) {
        if (video) {
          this.resumeOnTabReturn = !video.paused;
          if (this.resumeOnTabReturn) ncPlayer.silentPause();
          this.send('sync_tab_away', video.currentTime, { resume: this.resumeOnTabReturn });
          ncNotifications.showNote('Video paused (tab hidden)', 2000);
        }
      } else if (video) {
        const resume = this.resumeOnTabReturn;
        this.resumeOnTabReturn = false;
        if (resume) ncPlayer.remotePlay(video.currentTime);
        this.send('sync_tab_back', video.currentTime, { resume });
      }
    });
  },

  // === Inbound ============================================================

  acceptCommand(data) {
    if (data.source_user && ncUser.current && data.source_user === ncUser.current) {
      return false;
    }
    if (data.event_id) {
      if (this.seenEventIds.has(data.event_id)) return false;
      this.seenEventIds.add(data.event_id);
      if (this.seenEventIds.size > 200) {
        this.seenEventIds.delete(this.seenEventIds.values().next().value);
      }
    }
    if (data.stream_id && Number.isFinite(data.seq)) {
      const previous = this.lastSeqByStream.get(data.stream_id) || 0;
      if (data.seq <= previous) return false;
      this.lastSeqByStream.set(data.stream_id, data.seq);
    }
    const critical = data.command === 'sync_play' || data.command === 'sync_pause'
      || data.command === 'play' || data.command === 'pause';
    // Soft-dedupe critical commands that arrive twice without a shared event_id
    // (e.g. legacy dual transport).
    if (critical) {
      const bucket = Math.round((Number(data.seconds) || 0) * 2);
      const key = `${data.source_user || ''}|${data.command}|${bucket}`;
      const now = Date.now();
      if (!data.event_id && this._lastCriticalKey === key && now - this._lastCriticalAt < 450) {
        return false;
      }
      this._lastCriticalKey = key;
      this._lastCriticalAt = now;
      return true;
    }
    // Never drop play/pause as "stale" — clock skew was eating them.
    const age = ncStream.estimatedEventAgeMs(data);
    return age <= NC_CONFIG.COMMAND_STALE_MS;
  },

  compensatedSeconds(data, moving) {
    if (!Number.isFinite(data.seconds)) return data.seconds;
    if (!moving) return data.seconds;
    const ageS = ncStream.estimatedEventAgeMs(data) / 1000;
    return data.seconds + ageS * (Number(data.rate) || 1);
  },

  handleCommand(data) {
    if (!this.sessionEnabled) return;
    if (!this.acceptCommand(data)) return;
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
        if (ncPlayer.remotePlay(this.compensatedSeconds(data, true))) {
          ncNotifications.showNote(`${partner} played`, 1200);
          ncTelemetry.push({ action: 'sync_play_received', instant: true });
        }
        break;
      case 'sync_pause':
        if (ncPlayer.remotePause(this.compensatedSeconds(data, false))) {
          ncNotifications.showNote(`${partner} paused`, 1200);
          ncTelemetry.push({ action: 'sync_pause_received', instant: true });
        }
        break;
      case 'sync_seek': {
        const secs = this.compensatedSeconds(data, data.paused === false);
        if (ncPlayer.remoteSeek(secs, {
          force: false,
          moving: data.paused === false,
        })) {
          ncTelemetry.push({ action: 'sync_seek_received' });
        }
        // Preserve partner play/pause after the scrub (skip already did this).
        if (data.paused) ncPlayer.remotePause(secs);
        else ncPlayer.remotePlay(secs);
        break;
      }
      case 'sync_speed':
        if (ncPlayer.remoteRate(data.playback_rate)) {
          ncNotifications.showNote(`Speed changed to ${data.playback_rate}x`, 2000);
          ncTelemetry.push({ action: 'sync_speed_received' });
        }
        break;
      case 'sync_skip':
        this.holdingForPartnerSegment = false;
        data.seconds = this.compensatedSeconds(data, data.paused === false);
        if (ncPlayer.remoteSeek(data.seconds, { force: true })) {
          const label = { intro: 'Skipped intro', recap: 'Skipped recap' }[data.skip_type] || 'Skipped credits';
          ncNotifications.showNote(`${label} (synced)`, 2000);
          ncTelemetry.push({ action: `sync_skip_${data.skip_type}_received` });
        }
        if (data.paused) ncPlayer.remotePause(data.seconds);
        else ncPlayer.remotePlay(data.seconds);
        break;

      // Match the segment position without creating a one-sided pause.
      case 'sync_segment': {
        const segment = data.segment || 'intro';
        this.holdingForPartnerSegment = !!data.paused;
        if (data.paused) ncPlayer.remotePause(data.seconds);
        else ncPlayer.remotePlay(this.compensatedSeconds(data, true));
        const label = segment === 'intro' ? 'intro' : 'recap';
        ncNotifications.showNote(
          `${partner} is in the ${label} — aligned`,
          3500
        );
        ncTelemetry.push({ action: `sync_segment_${segment}_hold`, instant: true });
        break;
      }

      case 'sync_segment_clear':
        this.holdingForPartnerSegment = false;
        if (data.paused) ncPlayer.remotePause(data.seconds);
        else ncPlayer.remotePlay(this.compensatedSeconds(data, true));
        ncNotifications.showNote(`${partner} finished ${data.segment || 'segment'} — aligned`, 2500);
        break;

      case 'sync_tab_away':
        this.resumeAfterPartnerReturn = !!data.resume && !!ncGetVideo() && !ncGetVideo().paused;
        ncPlayer.silentPause();
        ncNotifications.showNote(`${partner} stepped away`, 3000);
        break;
      case 'sync_tab_back':
        if (data.resume && this.resumeAfterPartnerReturn) {
          ncPlayer.remotePlay(this.compensatedSeconds(data, true));
        }
        this.resumeAfterPartnerReturn = false;
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
    this.sessionEnabled = true;
    this.setupClickListeners();
    this.setupKeyboardListeners();
    this.tryAttachVideoListeners();
    this.setupTabVisibility();
    this.setupSegmentWatcher();
    this.ensureVideoObserver();

    window.addEventListener('beforeunload', () => {
      this.isPageUnloading = true;
    });
    // bfcache restore must re-enable outbound sync.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) this.isPageUnloading = false;
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
    if (typeof ncSession !== 'undefined' && !ncSession.isActive()) return;
    const data = await this._fetchDrift();
    if (!data || data.status !== 'behind') return;
    // Never auto-catch-up while either side is paused — that was overriding
    // a partner's intentional pause.
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
    if (typeof ncSession !== 'undefined' && !ncSession.isActive()) return;
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
    const secs = String(Math.floor(syncTo % 60)).padStart(2, '0');
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
