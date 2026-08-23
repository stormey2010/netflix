/**
 * Netflix Connect - Popup
 * Session management, shared watchlist, and stats.
 */

let currentUser = null;
let otherUser = null;
let pollTimer = null;
let activeTab = 'connect';
let refreshErrorCount = 0;
const MAX_REFRESH_ERRORS = 3;

const $ = (id) => document.getElementById(id);

// === Networking (with API key) =============================================

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'X-API-Key': NC_CONFIG.API_KEY } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function apiPost(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': NC_CONFIG.API_KEY },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// === UI helpers ============================================================

function setStatus(text, kind = 'ok') {
  const el = $('status');
  el.textContent = text;
  el.className = `status-toast ${kind}`;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status-toast';
  }, 3000);
}

function setHero(stateClass, main, detail = '') {
  $('hero').className = 'hero' + (stateClass ? ' ' + stateClass : '');
  $('connStatus').textContent = main;
  $('stateDetail').textContent = detail;
}

function openSetup() {
  chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
}

// === Session state =========================================================

function renderInviteState(data) {
  const invite = data?.invite;
  const connection = data?.connection;

  let status = 'none';
  if (connection) status = 'connected';
  else if (invite) status = invite.to === currentUser ? 'incoming' : 'waiting';

  const inviteBtn = $('invite');
  const incomingRow = $('incomingRow');
  const disconnectBtn = $('disconnect');

  inviteBtn.style.display = 'flex';
  incomingRow.style.display = 'none';
  disconnectBtn.style.display = 'none';
  inviteBtn.disabled = false;

  switch (status) {
    case 'waiting':
      setHero('waiting', `Waiting for ${otherUser}`, 'Invite sent - hang tight');
      inviteBtn.disabled = true;
      break;
    case 'incoming':
      setHero('incoming', `${otherUser} invited you`, 'Accept to start watching together');
      inviteBtn.style.display = 'none';
      incomingRow.style.display = 'flex';
      break;
    case 'connected':
      setHero('connected', `Connected with ${otherUser}`, 'Playback is synced');
      inviteBtn.style.display = 'none';
      disconnectBtn.style.display = 'flex';
      break;
    default:
      setHero('', 'Not connected', `Invite ${otherUser} to sync playback`);
      break;
  }
}

async function refreshState() {
  if (activeTab !== 'connect') return;
  try {
    const data = await apiGet(NC_CONFIG.ENDPOINTS.INVITE_STATUS);
    renderInviteState(data);
    refreshErrorCount = 0;
  } catch (e) {
    setHero('', 'Server unreachable', 'Check that the server is running');
    refreshErrorCount += 1;
    if (refreshErrorCount >= MAX_REFRESH_ERRORS && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}

async function sendInvite() {
  const btn = $('invite');
  try {
    btn.disabled = true;
    await apiPost(NC_CONFIG.ENDPOINTS.INVITE_SEND, { from_user: currentUser, to_user: otherUser });
    await refreshState();
    setStatus('Invite sent', 'ok');
  } catch (e) {
    setStatus(e.message || 'Failed to send invite', 'error');
    btn.disabled = false;
  }
}

async function acceptInvite() {
  try {
    const data = await apiPost(NC_CONFIG.ENDPOINTS.INVITE_ACCEPT, { from_user: currentUser, to_user: otherUser });
    if (data.status !== 'connected') throw new Error(data.message || 'Failed to accept');
    await refreshState();
    setStatus('Connected!', 'ok');
  } catch (e) {
    setStatus(e.message || 'Failed to accept', 'error');
  }
}

async function declineInvite() {
  try {
    await apiPost(NC_CONFIG.ENDPOINTS.INVITE_REJECT, { from_user: currentUser, to_user: otherUser });
    await refreshState();
  } catch (e) {
    setStatus(e.message || 'Failed to decline', 'error');
  }
}

async function endSession() {
  try {
    await apiPost(NC_CONFIG.ENDPOINTS.DISCONNECT, {});
    await refreshState();
    setStatus('Session ended', 'ok');
  } catch (e) {
    setStatus(e.message || 'Failed to disconnect', 'error');
  }
}

// === Netflix tab hint ======================================================

async function checkNetflixTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.netflix.com/*' });
    $('netflixHint').classList.toggle('visible', tabs.length === 0);
  } catch {}
}

// === Tabs ==================================================================

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  const panel = $(`tab-${tab}`);
  if (panel) panel.classList.add('active');
  activeTab = tab;
  if (activeTab === 'watchlist') loadWatchlist();
  else if (activeTab === 'stats') loadStats();
  else if (activeTab === 'settings') refreshUpdater();
  else refreshState();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

// === Watchlist =============================================================

function watchlistEmptyState(text, sub) {
  return `<div class="empty-state">
    <div class="empty-state-text">${text}</div>
    ${sub ? `<div class="empty-state-sub">${sub}</div>` : ''}
  </div>`;
}

async function loadWatchlist() {
  const container = $('watchlistContainer');
  try {
    const data = await apiGet(NC_CONFIG.ENDPOINTS.WATCHLIST);
    const items = data.watchlist || [];

    if (!items.length) {
      container.innerHTML = watchlistEmptyState(
        'Your shared watchlist is empty',
        'Add shows from Netflix detail pages'
      );
      return;
    }

    container.innerHTML = '';
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'list-item';

      const img = document.createElement('img');
      img.className = 'list-item-thumb';
      if (item.image_url) img.src = item.image_url;
      img.alt = '';
      img.onerror = () => { img.style.visibility = 'hidden'; };

      const info = document.createElement('div');
      info.className = 'list-item-info';
      const title = document.createElement('div');
      title.className = 'list-item-title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'list-item-meta';
      meta.textContent = `Added by ${item.added_by}`;
      info.append(title, meta);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'list-item-remove';
      removeBtn.title = 'Remove';
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromWatchlist(item.netflix_id, item.title);
      });

      row.append(img, info, removeBtn);
      row.addEventListener('click', () => {
        chrome.tabs.create({ url: `https://www.netflix.com/title/${item.netflix_id}` });
      });
      container.appendChild(row);
    });
  } catch (e) {
    container.innerHTML = watchlistEmptyState('Could not load watchlist', 'Is the server running?');
  }
}

async function removeFromWatchlist(netflixId, title) {
  try {
    await apiPost(NC_CONFIG.ENDPOINTS.WATCHLIST_REMOVE, {
      netflix_id: netflixId,
      title,
      removed_by: currentUser,
    });
    setStatus(`Removed "${title}"`, 'ok');
    loadWatchlist();
  } catch {
    setStatus('Failed to remove', 'error');
  }
}

// === Stats =================================================================

async function loadStats() {
  const set = (id, val) => { $(id).textContent = val; };
  try {
    const data = await apiGet(`${NC_CONFIG.ENDPOINTS.STATS}?days=30`);
    const totals = data.totals || {};
    const allTime = data.all_time || {};
    set('statHours', totals.watch_time_hours || 0);
    set('statSessions', totals.sessions || 0);
    set('statTitles', totals.titles || 0);
    set('statEpisodes', totals.episodes || 0);
    set('statAllTime', `${allTime.watch_time_hours || 0}h`);
  } catch {
    ['statHours', 'statSessions', 'statTitles', 'statEpisodes'].forEach((id) => set(id, '0'));
    set('statAllTime', '0h');
  }
}

// === Updater (macOS Native Messaging) ======================================

let updateState = { ready: false, available: false, remoteVersion: null };

function setUpdateUI({ label, detail, disabled, available }) {
  const btn = $('updateBtn');
  const meta = $('updateMeta');
  if (btn) {
    btn.textContent = label;
    btn.disabled = !!disabled;
  }
  if (typeof available === 'boolean') updateState.available = available;
  if (detail && meta) meta.innerHTML = detail;
}

async function refreshUpdater() {
  const manifest = chrome.runtime.getManifest();
  const localVersion = manifest.version || '?';
  $('localVersion').textContent = localVersion;

  setUpdateUI({ label: 'Checking…', disabled: true });

  const status = await ncUpdaterStatus();
  if (!status.success || status.helperInstalled === false) {
    const diagnosis = typeof ncDiagnoseHelperError === 'function'
      ? ncDiagnoseHelperError(status)
      : (status.error || 'Helper not installed');
    const id = status.extensionId || chrome.runtime.id || '?';
    setUpdateUI({
      label: 'Fix helper',
      disabled: false,
      available: false,
      detail: `Version <b>${localVersion}</b> · ID <code>${id}</code><br>${diagnosis}`,
    });
    $('updateBtn').textContent = 'Retry';
    $('updateBtn').onclick = () => refreshUpdater();
    return;
  }

  const check = await ncCheckUpdate();
  if (!check.success) {
    setUpdateUI({
      label: 'Check failed',
      disabled: false,
      available: false,
      detail: `Version <b>${localVersion}</b> · ${check.error || 'Unknown error'}`,
    });
    // Allow retry via button
    $('updateBtn').textContent = 'Retry check';
    $('updateBtn').onclick = () => refreshUpdater();
    return;
  }

  const commitShort = (check.remoteCommit || check.installedCommit || '').slice(0, 7);
  if (check.changed) {
    setUpdateUI({
      label: 'Update',
      disabled: false,
      available: true,
      detail: `Version <b>${localVersion}</b> · Update available${commitShort ? ` (${commitShort})` : ''}`,
    });
    $('updateBtn').onclick = () => runUpdate();
  } else {
    setUpdateUI({
      label: 'Check again',
      disabled: false,
      available: false,
      detail: `Version <b>${localVersion}</b> · Up to date${commitShort ? ` · ${commitShort}` : ''}`,
    });
    $('updateBtn').onclick = () => refreshUpdater();
  }
  updateState.ready = true;
}

async function runUpdate() {
  setUpdateUI({ label: 'Updating…', disabled: true });
  const result = await ncRunUpdate();
  if (!result.success) {
    setStatus(result.error || 'Update failed', 'error');
    setUpdateUI({ label: 'Update', disabled: false, available: true });
    $('updateBtn').onclick = () => runUpdate();
    return;
  }
  if (!result.changed) {
    setStatus('Already up to date', 'ok');
    await refreshUpdater();
    return;
  }
  setStatus(`Updated to ${result.newVersion || 'latest'}`, 'ok');
  setTimeout(() => chrome.runtime.reload(), 400);
}

async function setupUpdaterUI() {
  const stored = await chrome.storage.sync.get({ autoInstallUpdates: true });
  const toggle = $('autoUpdateToggle');
  if (toggle) {
    toggle.checked = !!stored.autoInstallUpdates;
    toggle.addEventListener('change', () => {
      chrome.storage.sync.set({ autoInstallUpdates: toggle.checked });
    });
  }
  await refreshUpdater();
}

// === Init ==================================================================

async function init() {
  const stored = await chrome.storage.sync.get(['user']);
  currentUser = stored.user || null;

  if (!currentUser) {
    openSetup();
    window.close();
    return;
  }

  const [a, b] = NC_CONFIG.USERS;
  otherUser = currentUser === a ? b : a;

  $('avatar').textContent = currentUser[0];
  $('userName').textContent = currentUser;
  $('hintText').textContent = `Watching with ${otherUser}`;

  setupTabs();
  $('settingsBtn').addEventListener('click', () => switchTab('settings'));
  $('switchProfileBtn').addEventListener('click', openSetup);
  $('invite').addEventListener('click', sendInvite);
  $('accept').addEventListener('click', acceptInvite);
  $('decline').addEventListener('click', declineInvite);
  $('disconnect').addEventListener('click', endSession);
  $('inviteLabel').textContent = `Invite ${otherUser}`;

  checkNetflixTab();
  await refreshState();
  pollTimer = setInterval(refreshState, 4000);
  setupUpdaterUI();
}

init();
