/**
 * Netflix Connect - User Identity
 * Loads the selected profile from chrome.storage.sync and tracks changes.
 */

const ncUser = {
  current: null,
  loaded: false,

  get partner() {
    if (!this.current) return null;
    const [a, b] = NC_CONFIG.USERS;
    return this.current === a ? b : a;
  },

  async load() {
    try {
      const res = await chrome.storage.sync.get(['user']);
      this.current = res?.user || 'unknown';
    } catch (e) {
      this.current = 'unknown';
      console.error('[Netflix Connect] Failed to load user:', e);
    }
    this.loaded = true;
    return this.current;
  },

  setupChangeListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.user) {
        this.current = changes.user.newValue || 'unknown';
        console.log('[Netflix Connect] User changed to:', this.current);
        // Reconnect the stream so server-side targeting uses the new identity.
        if (typeof ncStream !== 'undefined' && !ncStream.stopped) ncStream.restart();
      }
    });
  },
};
