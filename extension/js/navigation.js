/**
 * Netflix Connect - Navigation
 * Reports page changes to the server and follows the partner when the server
 * sends a nav-sync event on the unified stream.
 */

const ncNavigation = {
  lastReportedUrl: null,
  lastReportedWatchId: null,
  lastUrl: window.location.href,
  urlCheckCallback: null,
  enabled: false,
  historyPatched: false,
  /** Set when we are about to follow a partner navigate event. */
  pendingFollow: false,

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.lastReportedUrl = null;
      this.lastReportedWatchId = null;
      this.pendingFollow = false;
    }
  },

  async report(opts = {}) {
    if (!this.enabled) return;
    if (!ncUser.current || ncUser.current === 'unknown') return;

    const currentUrl = window.location.href;
    const watchId = ncGetWatchId();
    const force = !!opts.force;
    if (!force && currentUrl === this.lastReportedUrl && watchId === this.lastReportedWatchId) {
      return;
    }

    const video = ncGetVideo();
    if (ncGetPageType() === 'watch' && !video) {
      setTimeout(() => this.report(opts), 250);
      return;
    }
    this.lastReportedUrl = currentUrl;
    this.lastReportedWatchId = watchId;
    const positionS = video && Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000) / 1000
      : null;
    const followed = this.pendingFollow;
    if (followed) this.pendingFollow = false;

    try {
      await ncPost(NC_CONFIG.ENDPOINTS.NAV_UPDATE, {
        user: ncUser.current,
        url: currentUrl,
        page_type: ncGetPageType(),
        watch_id: watchId,
        position_s: positionS,
        paused: video ? video.paused : null,
        followed: followed || undefined,
      });
    } catch {
      // Server offline; ignore.
    }
  },

  handleNavEvent(data) {
    if (!this.enabled) return;
    if (data?.action !== 'navigate' || !data.url) return;
    console.log(`[Netflix Connect] Nav sync: ${data.reason} -> ${data.url}`);
    ncNotifications.showSyncing(data.reason || 'Following your partner...');
    this.pendingFollow = true;
    try {
      sessionStorage.setItem('nc_pending_nav_sync', JSON.stringify({
        seconds: data.seconds,
        paused: data.paused,
        createdAt: Date.now(),
      }));
      sessionStorage.setItem('nc_pending_follow', '1');
    } catch {}
    setTimeout(() => {
      window.location.href = data.url;
    }, NC_CONFIG.NAV_DELAY_MS);
  },

  applyPendingSync(attempt = 0) {
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('nc_pending_nav_sync') || 'null'); }
    catch {}
    if (!pending || Date.now() - pending.createdAt > 30000) {
      try { sessionStorage.removeItem('nc_pending_nav_sync'); } catch {}
      return;
    }
    const video = ncGetVideo();
    if (!video || video.readyState < 2) {
      // Apply pause immediately even while buffering; retry seek/play when ready.
      if (pending.paused && video) {
        try { ncPlayer.remotePause(pending.seconds); } catch {}
      }
      if (attempt < 80) {
        if (video && attempt === 0) {
          video.addEventListener('canplay', () => this.applyPendingSync(1), { once: true });
        }
        setTimeout(() => this.applyPendingSync(attempt + 1), 250);
      }
      return;
    }
    try { sessionStorage.removeItem('nc_pending_nav_sync'); } catch {}
    if (pending.paused) ncPlayer.remotePause(pending.seconds);
    else ncPlayer.remotePlay(pending.seconds);
    console.log('[Netflix Connect] Applied playback state after navigation');
  },

  checkUrlChange() {
    if (window.location.href === this.lastUrl) return;
    this.lastUrl = window.location.href;
    this.report();
    // Netflix replaces <video> on SPA navigations — rebind outbound listeners.
    if (typeof ncSync !== 'undefined' && ncSync.sessionEnabled) {
      ncSync.tryAttachVideoListeners();
    }
  },

  setupUrlTracking() {
    this.urlCheckCallback = () => this.checkUrlChange();
    ncTicker.onFastTick(this.urlCheckCallback);

    window.addEventListener('popstate', () => setTimeout(() => this.report(), 100));

    if (this.historyPatched) return;
    this.historyPatched = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const self = this;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      setTimeout(() => self.report(), 100);
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      setTimeout(() => self.report(), 100);
    };
  },

  init() {
    this.enabled = true;
    try {
      if (sessionStorage.getItem('nc_pending_follow') === '1') {
        this.pendingFollow = true;
        sessionStorage.removeItem('nc_pending_follow');
      }
    } catch {}
    this.setupUrlTracking();
    ncStream.on('nav', (data) => this.handleNavEvent(data));
    this.report();
    this.applyPendingSync();
  },
};
