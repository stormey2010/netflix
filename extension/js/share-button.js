/**
 * Netflix Connect - Detail Modal Buttons
 * Injects Share and Shared-Watchlist buttons into Netflix's detail modal.
 */

const ncShareButton = {
  injected: false,
  enabled: false,
  observer: null,
  lastUrlForModal: window.location.href,
  currentNetflixId: null,
  isInWatchlist: false,
  watchlistBtn: null,

  ICONS: {
    share: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" role="img"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"></path></svg>`,
    add: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" role="img"><path fill="currentColor" d="M13 4v7h7v2h-7v7h-2v-7H4v-2h7V4h2z"></path></svg>`,
    added: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" role="img"><path fill="#2dd573" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"></path></svg>`,
  },

  _makeButton(id, label, iconHtml, onClick) {
    const btn = document.createElement('div');
    btn.id = id;
    btn.className = 'previewModal-close';
    btn.style.cssText = 'opacity: 1; position: relative; cursor: pointer;';
    btn.innerHTML = `
      <span role="button" aria-label="${label}" tabindex="0" title="${label}">${iconHtml}</span>
    `;
    btn.addEventListener('click', onClick);
    return btn;
  },

  getModalInfo() {
    const urlParams = new URLSearchParams(window.location.search);
    let netflixId = urlParams.get('jbv');
    if (!netflixId && window.location.pathname.includes('/title/')) {
      const match = window.location.pathname.match(/\/title\/(\d+)/);
      if (match) netflixId = match[1];
    }

    const modal = document.querySelector('[data-uia="modal-motion-container-DETAIL_MODAL"]');
    const titleImg = modal?.querySelector('.previewModal--player-titleTreatment-logo');
    const boxartImg = modal?.querySelector('.previewModal--boxart');
    const title = titleImg?.alt || boxartImg?.alt || 'this show';
    const imageUrl = boxartImg?.src || titleImg?.src || null;

    return { netflixId, title, imageUrl };
  },

  async handleShare() {
    const { netflixId, title } = this.getModalInfo();
    if (!netflixId) return;

    try {
      await ncPost(NC_CONFIG.ENDPOINTS.COMMAND, {
        command: 'share',
        url: `https://www.netflix.com/title/${netflixId}`,
        title,
        source_user: ncUser.current,
      });
      ncNotifications.showShareSent(title);
    } catch (e) {
      console.error('[Netflix Connect] Share failed:', e);
      ncNotifications.showNote('Failed to share with partner');
    }
  },

  async handleWatchlistToggle() {
    const { netflixId, title, imageUrl } = this.getModalInfo();
    if (!netflixId) return;

    const wasInWatchlist = this.isInWatchlist;
    this.isInWatchlist = !wasInWatchlist;
    this.updateWatchlistButtonState(this.isInWatchlist);

    try {
      const response = wasInWatchlist
        ? await ncPost(NC_CONFIG.ENDPOINTS.WATCHLIST_REMOVE, {
            netflix_id: netflixId, title, removed_by: ncUser.current,
          })
        : await ncPost(NC_CONFIG.ENDPOINTS.WATCHLIST_ADD, {
            netflix_id: netflixId, title, added_by: ncUser.current,
            image_url: imageUrl, content_type: 'unknown',
          });

      const ok = wasInWatchlist
        ? response.status === 'removed'
        : response.status === 'added' || response.status === 'exists';
      if (!ok) {
        this.isInWatchlist = wasInWatchlist;
        this.updateWatchlistButtonState(wasInWatchlist);
      }
    } catch (e) {
      console.error('[Netflix Connect] Watchlist operation failed:', e);
      this.isInWatchlist = wasInWatchlist;
      this.updateWatchlistButtonState(wasInWatchlist);
      ncNotifications.showNote('Failed to update watchlist');
    }
  },

  updateWatchlistButtonState(isInWatchlist) {
    const btn = this.watchlistBtn || document.getElementById('netflix-connect-watchlist-btn');
    const span = btn?.querySelector('span');
    if (!span) return;

    span.innerHTML = isInWatchlist ? this.ICONS.added : this.ICONS.add;
    const label = isInWatchlist ? 'Remove from shared watchlist' : 'Add to shared watchlist';
    span.title = label;
    span.setAttribute('aria-label', label);
  },

  async checkWatchlistStatus(netflixId) {
    if (!netflixId) return;
    try {
      const data = await ncGet(`${NC_CONFIG.ENDPOINTS.WATCHLIST_CHECK}/${netflixId}`);
      this.isInWatchlist = data.in_watchlist;
      this.updateWatchlistButtonState(data.in_watchlist);
    } catch (e) {
      console.error('[Netflix Connect] Watchlist check failed:', e);
    }
  },

  inject(modal) {
    if (this.injected) return;
    const closeBtn = modal.querySelector('.previewModal-close');
    if (!closeBtn) return;

    const container = document.createElement('div');
    container.id = 'netflix-connect-buttons';
    container.style.cssText = 'display: flex; position: absolute; left: 0; top: 0;';

    container.appendChild(
      this._makeButton('netflix-connect-share-btn', 'Share with partner', this.ICONS.share, () => this.handleShare())
    );
    this.watchlistBtn = this._makeButton(
      'netflix-connect-watchlist-btn', 'Add to shared watchlist', this.ICONS.add, () => this.handleWatchlistToggle()
    );
    container.appendChild(this.watchlistBtn);

    closeBtn.parentNode.insertBefore(container, closeBtn);
    this.injected = true;

    const { netflixId } = this.getModalInfo();
    if (netflixId) {
      this.currentNetflixId = netflixId;
      this.checkWatchlistStatus(netflixId);
    }
  },

  remove() {
    const container = document.getElementById('netflix-connect-buttons');
    if (container) {
      container.remove();
      this.injected = false;
      this.currentNetflixId = null;
      this.watchlistBtn = null;
      this.isInWatchlist = false;
    }
  },

  check() {
    if (!this.enabled) {
      this.remove();
      return;
    }
    const modal = document.querySelector('[data-uia="modal-motion-container-DETAIL_MODAL"]');
    const hasJbv = new URLSearchParams(window.location.search).has('jbv');
    const hasTitle = window.location.pathname.includes('/title/');

    if (modal && (hasJbv || hasTitle)) {
      this.inject(modal);
    } else {
      this.remove();
    }
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.remove();
      return;
    }
    this.check();
  },

  init() {
    this.enabled = true;
    this.observer = new MutationObserver(() => {
      requestIdleCallback(() => this.check(), { timeout: 100 });
    });

    const scopeObserver = () => {
      const container = document.querySelector('.mainView, [data-uia="content-container"], #appMountPoint') || document.body;
      if (container) this.observer.observe(container, { childList: true, subtree: true });
      this.check();
    };

    if (document.body) {
      scopeObserver();
    } else {
      document.addEventListener('DOMContentLoaded', scopeObserver);
    }

    window.addEventListener('popstate', () => setTimeout(() => this.check(), 100));

    ncTicker.onFastTick(() => {
      if (!this.enabled) return;
      if (window.location.href !== this.lastUrlForModal) {
        this.lastUrlForModal = window.location.href;
        this.check();
      }
    });
  },
};
