/**
 * Netflix Connect - Navigation
 * Reports page changes to the server and follows the partner when the server
 * sends a nav-sync event on the unified stream.
 */

const ncNavigation = {
  lastReportedUrl: null,
  lastUrl: window.location.href,
  urlCheckCallback: null,

  async report() {
    if (!ncUser.current || ncUser.current === 'unknown') return;

    const currentUrl = window.location.href;
    if (currentUrl === this.lastReportedUrl) return;
    this.lastReportedUrl = currentUrl;

    const video = ncGetVideo();
    const positionS = video && Number.isFinite(video.currentTime)
      ? Math.floor(video.currentTime)
      : null;

    try {
      await ncPost(NC_CONFIG.ENDPOINTS.NAV_UPDATE, {
        user: ncUser.current,
        url: currentUrl,
        page_type: ncGetPageType(),
        watch_id: ncGetWatchId(),
        position_s: positionS,
      });
    } catch {
      // Server offline; ignore.
    }
  },

  handleNavEvent(data) {
    if (data?.action !== 'navigate' || !data.url) return;
    console.log(`[Netflix Connect] Nav sync: ${data.reason} -> ${data.url}`);
    ncNotifications.showSyncing(data.reason || 'Following your partner...');
    setTimeout(() => {
      window.location.href = data.url;
    }, NC_CONFIG.NAV_DELAY_MS);
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
    this.setupUrlTracking();
    ncStream.on('nav', (data) => this.handleNavEvent(data));
    this.report();
  },
};
