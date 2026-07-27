/**
 * Netflix Connect - Notifications
 * In-page toast system, connection status badge, and invite handling.
 * Listens to the `invite` and `init` channels on the unified event stream.
 */

const ncNotifications = {
  container: null,
  statusBadge: null,
  isConnected: false,
  partnerName: null,
  pendingAccept: false,

  init() {
    this.injectStyles();
    this.createContainer();
    this.createStatusBadge();

    ncStream.on('init', (data) => this.handleInit(data));
    ncStream.on('invite', (data) => this.handleInviteEvent(data));
    ncTicker.onFastTick(() => this.updateStatusBadge());
  },

  injectStyles() {
    if (document.getElementById('nc-styles')) return;

    const style = document.createElement('style');
    style.id = 'nc-styles';
    style.textContent = `
      #nc-toasts {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column-reverse;
        gap: 10px;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .nc-toast {
        pointer-events: auto;
        width: 330px;
        background: rgba(18, 18, 22, 0.92);
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
        overflow: hidden;
        opacity: 0;
        transform: translateY(16px) scale(0.96);
        transition: opacity 0.3s cubic-bezier(0.34, 1.3, 0.64, 1),
                    transform 0.3s cubic-bezier(0.34, 1.3, 0.64, 1);
      }
      .nc-toast.visible { opacity: 1; transform: translateY(0) scale(1); }
      .nc-toast.exit { opacity: 0; transform: translateY(-8px) scale(0.96); pointer-events: none; }

      .nc-toast-main { padding: 14px 16px; display: flex; gap: 12px; }

      .nc-toast-icon {
        width: 32px; height: 32px; flex-shrink: 0;
        border-radius: 9px;
        display: flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--nc-accent, #e50914) 16%, transparent);
        color: var(--nc-accent, #e50914);
      }
      .nc-toast-icon svg { width: 16px; height: 16px; fill: currentColor; }

      .nc-toast-content { flex: 1; min-width: 0; padding-top: 1px; }
      .nc-toast-title { font-size: 13px; font-weight: 650; color: #fff; line-height: 1.35; letter-spacing: 0.1px; }
      .nc-toast-msg { font-size: 12px; color: #93939d; margin-top: 3px; line-height: 1.45; }

      .nc-toast-close {
        width: 26px; height: 26px;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: none;
        color: #5a5a64; cursor: pointer; border-radius: 7px;
        margin: -4px -6px 0 4px; flex-shrink: 0;
        transition: background 0.15s, color 0.15s;
      }
      .nc-toast-close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
      .nc-toast-close svg { width: 13px; height: 13px; fill: currentColor; }

      .nc-toast-actions { display: flex; gap: 8px; margin-top: 12px; }
      .nc-btn {
        height: 32px; padding: 0 15px; border-radius: 8px;
        font-size: 12px; font-weight: 650; letter-spacing: 0.2px;
        border: none; cursor: pointer;
        font-family: inherit;
        transition: filter 0.15s, background 0.15s, transform 0.1s;
      }
      .nc-btn:active { transform: scale(0.96); }
      .nc-btn-primary { background: #e50914; color: #fff; }
      .nc-btn-primary:hover { filter: brightness(1.12); }
      .nc-btn-secondary { background: rgba(255, 255, 255, 0.08); color: #cfcfd6; }
      .nc-btn-secondary:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }

      .nc-share-card {
        margin-top: 10px; padding: 9px 11px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 9px;
        display: flex; align-items: center; gap: 10px;
      }
      .nc-share-icon {
        width: 28px; height: 28px; border-radius: 7px; flex-shrink: 0;
        background: rgba(229, 9, 20, 0.14);
        display: flex; align-items: center; justify-content: center;
      }
      .nc-share-icon svg { width: 13px; height: 13px; fill: #e50914; }
      .nc-share-name {
        font-size: 12px; color: #e6e6ea; font-weight: 550;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      .nc-toast-progress { height: 2px; background: rgba(255, 255, 255, 0.05); }
      .nc-toast-progress-fill {
        height: 100%;
        background: var(--nc-accent, #e50914);
        opacity: 0.55;
        animation: nc-shrink linear forwards;
        transform-origin: left;
      }
      @keyframes nc-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }

      #nc-status {
        position: fixed;
        bottom: 20px; right: 20px;
        z-index: 2147483640;
        display: flex; align-items: center; gap: 7px;
        background: rgba(18, 18, 22, 0.85);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.07);
        padding: 7px 13px 7px 11px;
        border-radius: 999px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        opacity: 0; transform: translateY(6px);
        transition: opacity 0.25s ease, transform 0.25s ease;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      #nc-status.visible { opacity: 1; transform: translateY(0); }
      .nc-status-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #2dd573;
        animation: nc-glow 2.4s ease-in-out infinite;
      }
      @keyframes nc-glow {
        0%, 100% { box-shadow: 0 0 0 0 rgba(45, 213, 115, 0.4); }
        50% { opacity: 0.7; box-shadow: 0 0 0 5px rgba(45, 213, 115, 0); }
      }
      .nc-status-label { font-size: 11px; color: rgba(255, 255, 255, 0.55); }
      .nc-status-name { font-size: 11px; font-weight: 650; color: #2dd573; }
    `;
    document.head.appendChild(style);
  },

  createContainer() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.id = 'nc-toasts';
    (document.body || document.documentElement).appendChild(this.container);
  },

  createStatusBadge() {
    if (this.statusBadge) return;
    this.statusBadge = document.createElement('div');
    this.statusBadge.id = 'nc-status';
    this.statusBadge.innerHTML = `
      <div class="nc-status-dot"></div>
      <span class="nc-status-label">with</span>
      <span class="nc-status-name"></span>
    `;
    (document.body || document.documentElement).appendChild(this.statusBadge);
  },

  updateStatusBadge() {
    if (!this.statusBadge) return;
    const onWatchPage = window.location.pathname.includes('/watch');
    if (this.isConnected && this.partnerName && !onWatchPage) {
      this.statusBadge.querySelector('.nc-status-name').textContent = this.partnerName;
      this.statusBadge.classList.add('visible');
    } else {
      this.statusBadge.classList.remove('visible');
    }
  },

  icons: {
    invite: `<svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    share: `<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
    disconnect: `<svg viewBox="0 0 24 24"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
    sync: `<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  },

  esc(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
  },

  show(opts) {
    if (!this.container) this.createContainer();
    const {
      type = 'info', title = '', message = '', actions = [],
      duration = 3500, shareTitle = null,
    } = opts;

    const colors = { invite: '#e50914', share: '#e50914', connect: '#2dd573', disconnect: '#8b8b95', sync: '#e50914', info: '#e50914' };
    const iconMap = { invite: 'invite', share: 'share', connect: 'check', disconnect: 'disconnect', sync: 'sync', info: 'sync' };

    const toast = document.createElement('div');
    toast.className = 'nc-toast';
    toast.style.setProperty('--nc-accent', colors[type] || colors.info);

    const actionsHtml = actions.length
      ? `<div class="nc-toast-actions">${actions.map((a, i) =>
          `<button class="nc-btn ${a.primary ? 'nc-btn-primary' : 'nc-btn-secondary'}" data-i="${i}">${this.esc(a.label)}</button>`
        ).join('')}</div>`
      : '';

    const shareHtml = shareTitle
      ? `<div class="nc-share-card">
           <div class="nc-share-icon">${this.icons.play}</div>
           <div class="nc-share-name">${this.esc(shareTitle)}</div>
         </div>`
      : '';

    toast.innerHTML = `
      <div class="nc-toast-main">
        <div class="nc-toast-icon">${this.icons[iconMap[type]] || this.icons.sync}</div>
        <div class="nc-toast-content">
          <div class="nc-toast-title">${this.esc(title)}</div>
          ${message ? `<div class="nc-toast-msg">${this.esc(message)}</div>` : ''}
          ${shareHtml}
          ${actionsHtml}
        </div>
        <button class="nc-toast-close">${this.icons.close}</button>
      </div>
      ${duration > 0 ? `<div class="nc-toast-progress"><div class="nc-toast-progress-fill" style="animation-duration:${duration}ms"></div></div>` : ''}
    `;

    toast.querySelector('.nc-toast-close').onclick = () => this.dismiss(toast);
    actions.forEach((a, i) => {
      const btn = toast.querySelector(`[data-i="${i}"]`);
      if (btn) btn.onclick = () => { if (a.action) a.action(); this.dismiss(toast); };
    });

    this.container.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    if (duration > 0) setTimeout(() => this.dismiss(toast), duration);
    return toast;
  },

  dismiss(toast) {
    if (!toast?.parentNode) return;
    toast.classList.remove('visible');
    toast.classList.add('exit');
    setTimeout(() => toast.parentNode?.removeChild(toast), 300);
  },

  // === Notification helpers ===

  showInviteReceived(from) {
    return this.show({
      type: 'invite',
      title: `${from} wants to watch together`,
      message: 'Accept to sync playback',
      duration: 0,
      actions: [
        { label: 'Accept', primary: true, action: () => this.acceptInvite(from) },
        { label: 'Decline', primary: false, action: () => this.declineInvite(from) },
      ],
    });
  },

  showConnected(partner) {
    this.isConnected = true;
    this.partnerName = partner;
    this.updateStatusBadge();
    return this.show({ type: 'connect', title: `Connected with ${partner}`, message: 'Playback is now synced', duration: 3000 });
  },

  showDisconnected() {
    this.isConnected = false;
    this.partnerName = null;
    this.updateStatusBadge();
    return this.show({ type: 'disconnect', title: 'Session ended', duration: 2500 });
  },

  showShareReceived(from, title, url) {
    return this.show({
      type: 'share',
      title: `${from} shared something`,
      shareTitle: title,
      duration: 0,
      actions: [
        { label: 'Watch', primary: true, action: () => { if (url) window.location.href = url; } },
        { label: 'Later', primary: false, action: () => {} },
      ],
    });
  },

  showShareSent(title) {
    return this.show({ type: 'share', title: 'Shared with partner', message: title, duration: 2500 });
  },

  showWatchlistChange(kind, actor, title) {
    const mine = actor === ncUser.current;
    const verb = kind === 'added' ? 'added to' : 'removed from';
    return this.show({
      type: 'info',
      title: mine ? `Watchlist ${kind === 'added' ? 'updated' : 'trimmed'}` : `${actor} ${verb} the watchlist`,
      message: `"${title}"`,
      duration: mine ? 2500 : 4000,
    });
  },

  showSyncing(msg) {
    return this.show({ type: 'sync', title: 'Syncing', message: msg || 'Following partner...', duration: 2000 });
  },

  showNote(msg, dur = 3000) {
    return this.show({ type: 'info', title: 'Netflix Connect', message: msg, duration: dur });
  },

  // === Invite API ===

  async acceptInvite(from) {
    try {
      this.pendingAccept = true;
      const data = await ncPost(NC_CONFIG.ENDPOINTS.INVITE_ACCEPT, {
        from_user: ncUser.current,
        to_user: from,
      });
      if (data.status === 'connected') this.showConnected(from);
      else this.showNote(data.message || 'Failed to accept invite');
    } catch {
      this.showNote('Failed to accept invite');
    } finally {
      setTimeout(() => { this.pendingAccept = false; }, 1000);
    }
  },

  async declineInvite(from) {
    try {
      await ncPost(NC_CONFIG.ENDPOINTS.INVITE_REJECT, { from_user: ncUser.current, to_user: from });
    } catch {}
  },

  // === Stream handlers ===

  handleInit(data) {
    const me = ncUser.current;
    if (!me) return;
    if (data.invite?.to === me) this.showInviteReceived(data.invite.from);
    if (data.connection?.users) {
      const partner = data.connection.users.find((u) => u !== me);
      if (partner) {
        this.isConnected = true;
        this.partnerName = partner;
        this.updateStatusBadge();
      }
    }
  },

  handleInviteEvent(data) {
    const me = ncUser.current;
    if (!me) return;

    switch (data.event) {
      case 'invite_received':
        if (data.to === me) this.showInviteReceived(data.from);
        break;
      case 'connected': {
        if (this.pendingAccept) return; // we already showed it on accept
        const partner = data.users?.find((u) => u !== me);
        if (partner) this.showConnected(partner);
        break;
      }
      case 'disconnected':
        if (data.users?.includes(me)) this.showDisconnected();
        break;
      case 'rejected':
        if (data.from === me) this.showNote(`${data.rejected_by} declined`);
        break;
    }
  },
};