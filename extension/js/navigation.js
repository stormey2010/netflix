/**
 * Netflix Connect - Navigation
 * Reports page changes to the server and follows the partner when the server
 * sends a nav-sync event on the unified stream.
 */

const ncNavigation = {
  lastReportedUrl: null,
  lastUrl: window.location.href,
  urlCheckCallback: null,
  enabled: false,
  historyPatched: false,

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.lastReportedUrl = null;
  },

  async report() {
    if (!this.enabled) return;
    if (!ncUser.current || ncUser.current === 'unknown') return;

    const currentUrl = window.location.href;
    if (currentUrl === this.lastReportedUrl) return;

    const video = ncGetVideo();
    if (ncGetPageType() === 'watch' && !video) {
      setTimeout(() => this.report(), 250);
      return;
    }
    this.lastReportedUrl = currentUrl;
    const positionS = video && Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000) / 1000
      : null;

    try {
      await ncPost(NC_CONFIG.ENDPOINTS.NAV_UPDATE, {
        user: ncUser.current,
        url: currentUrl,
        page_type: ncGetPageType(),
        watch_id: ncGetWatchId(),
        position_s: positionS,
        paused: video ? video.paused : null,
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
    try {
      sessionStorage.setItem('nc_pending_nav_sync', JSON.stringify({
        seconds: data.seconds,
        paused: data.paused,
        createdAt: Date.now(),
      }));
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
      if (attempt < 40) setTimeout(() => this.applyPendingSync(attempt + 1), 250);
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
    this.setupUrlTracking();
    ncStream.on('nav', (data) => this.handleNavEvent(data));
    this.report();
    this.applyPendingSync();
  },
};
