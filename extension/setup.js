/**
 * Netflix Connect - Setup
 * Profile picker + macOS updater controls.
 */

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #e50914, #8f0610)',
  'linear-gradient(135deg, #6d5df6, #3d2f9e)',
];

const $ = (id) => document.getElementById(id);

function buildProfiles(selectedUser) {
  const container = $('profiles');
  container.innerHTML = '';

  NC_CONFIG.USERS.forEach((name) => {
    const btn = document.createElement('button');
    btn.className = 'profile' + (name === selectedUser ? ' selected' : '');
    btn.innerHTML = `
      <div class="profile-avatar">${name[0]}</div>
      <span class="profile-name">${name}</span>
    `;
    btn.addEventListener('click', () => selectUser(name));
    container.appendChild(btn);
  });
}

async function selectUser(name) {
  document.querySelectorAll('.profile').forEach((p) => {
    p.classList.toggle('selected', p.querySelector('.profile-name').textContent === name);
  });

  await chrome.storage.sync.set({ user: name });

  setTimeout(() => {
    const idx = NC_CONFIG.USERS.indexOf(name);
    const partner = NC_CONFIG.USERS.find((u) => u !== name);
    const avatar = $('successAvatar');
    avatar.textContent = name[0];
    avatar.style.background = AVATAR_GRADIENTS[Math.max(0, idx)];
    $('successSub').textContent = `Ready to watch together with ${partner}`;
    $('stage').classList.add('done');
    $('success').classList.add('visible');
  }, 250);
}

function setUpdateUI({ label, detail, disabled }) {
  const btn = $('updateBtn');
  const meta = $('updateMeta');
  if (btn) {
    btn.textContent = label;
    btn.disabled = !!disabled;
  }
  if (detail && meta) meta.innerHTML = detail;
}

function openInstallerRepo() {
  chrome.tabs.create({ url: NC_INSTALLER_URL });
}

async function refreshUpdater() {
  const manifest = chrome.runtime.getManifest();
  const localVersion = manifest.version || '?';
  if ($('localVersion')) $('localVersion').textContent = localVersion;

  setUpdateUI({ label: 'Checking…', disabled: true });

  const status = await ncUpdaterStatus();
  if (!status.success || status.helperInstalled === false) {
    const diagnosis = typeof ncDiagnoseHelperError === 'function'
      ? ncDiagnoseHelperError(status)
      : (status.error || 'Helper not installed');
    const id = status.extensionId || chrome.runtime.id || '?';
    setUpdateUI({
      label: 'Open installer',
      disabled: false,
      detail: `Version <b>${localVersion}</b> · ID <code>${id}</code><br>${diagnosis}`,
    });
    $('updateBtn').onclick = () => openInstallerRepo();
    return;
  }

  // Old helpers rename/delete Chrome's extension folder. Refuse to run them.
  if (!ncHelperIsCurrent(status)) {
    setUpdateUI({
      label: 'Fix helper first',
      disabled: false,
      detail:
        `Version <b>${localVersion}</b><br>` +
        'Your Mac helper is outdated and is what was deleting the extension. ' +
        'Re-run <b>Install Netflix Connect.command</b> once (from netflixupdater), Cmd+Q Chrome, then come back.',
    });
    $('updateBtn').onclick = () => openInstallerRepo();
    return;
  }

  const check = await ncCheckUpdate();
  if (!check.success) {
    setUpdateUI({
      label: 'Retry check',
      disabled: false,
      detail: `Version <b>${localVersion}</b> · ${check.error || 'Unknown error'}`,
    });
    $('updateBtn').onclick = () => refreshUpdater();
    return;
  }

  if (!ncHelperIsCurrent(check)) {
    setUpdateUI({
      label: 'Fix helper first',
      disabled: false,
      detail: 'Helper is outdated. Re-run Install Netflix Connect.command before updating.',
    });
    $('updateBtn').onclick = () => openInstallerRepo();
    return;
  }

  const commitShort = (check.remoteCommit || check.installedCommit || '').slice(0, 7);
  if (check.changed) {
    setUpdateUI({
      label: 'Update',
      disabled: false,
      detail: `Version <b>${localVersion}</b> · Update available${commitShort ? ` (${commitShort})` : ''}`,
    });
    $('updateBtn').onclick = () => runUpdate();
  } else {
    setUpdateUI({
      label: 'Check again',
      disabled: false,
      detail: `Version <b>${localVersion}</b> · Up to date${commitShort ? ` · ${commitShort}` : ''}`,
    });
    $('updateBtn').onclick = () => refreshUpdater();
  }
}

async function runUpdate() {
  setUpdateUI({ label: 'Updating…', disabled: true });

  const status = await ncUpdaterStatus();
  if (!ncHelperIsCurrent(status)) {
    setUpdateUI({
      label: 'Fix helper first',
      disabled: false,
      detail: 'Blocked: outdated helper can delete the extension. Re-run the installer first.',
    });
    $('updateBtn').onclick = () => openInstallerRepo();
    return;
  }

  const result = await ncRunUpdate();
  if (!result.success) {
    setUpdateUI({
      label: 'Update',
      disabled: false,
      detail: result.error || 'Update failed',
    });
    $('updateBtn').onclick = () => runUpdate();
    return;
  }
  if (!result.changed) {
    await refreshUpdater();
    return;
  }

  if (!result.diskManifestOK) {
    setUpdateUI({
      label: 'Open extensions',
      disabled: false,
      detail:
        'Update finished but the helper could not re-read manifest.json on disk. ' +
        'Do <b>not</b> reload yet — re-run the installer, or Load unpacked from ' +
        '<code>~/Library/Application Support/NetflixConnect/extension</code>',
    });
    $('updateBtn').onclick = () => chrome.tabs.create({ url: 'chrome://extensions' });
    return;
  }

  // Re-read from disk through the helper (not Chrome's in-memory cache).
  await new Promise((r) => setTimeout(r, 500));
  const verify = await ncUpdaterStatus();
  if (!verify.diskManifestOK || !verify.diskManifestVersion) {
    setUpdateUI({
      label: 'Open extensions',
      disabled: false,
      detail: 'Files may be incomplete on disk. Skip Reload — Load unpacked again from Application Support/NetflixConnect/extension',
    });
    $('updateBtn').onclick = () => chrome.tabs.create({ url: 'chrome://extensions' });
    return;
  }

  setUpdateUI({
    label: 'Reloading…',
    disabled: true,
    detail: `Disk OK at <b>${verify.diskManifestVersion}</b> — reloading…`,
  });

  // Last resort if reload bricks: user can Load unpacked again; folder was not deleted.
  try {
    chrome.runtime.reload();
  } catch {
    setUpdateUI({
      label: 'Open extensions',
      disabled: false,
      detail: `Updated to <b>${verify.diskManifestVersion}</b> on disk. Click Reload on chrome://extensions.`,
    });
    $('updateBtn').onclick = () => chrome.tabs.create({ url: 'chrome://extensions' });
  }
}

async function setupUpdaterUI() {
  // Default auto-install OFF — silent updates were breaking unpacked installs.
  const stored = await chrome.storage.sync.get({ autoInstallUpdates: false });
  const toggle = $('autoUpdateToggle');
  if (toggle) {
    toggle.checked = !!stored.autoInstallUpdates;
    toggle.addEventListener('change', () => {
      chrome.storage.sync.set({ autoInstallUpdates: toggle.checked });
    });
  }
  await refreshUpdater();
}

$('closeBtn').addEventListener('click', () => window.close());

chrome.storage.sync.get(['user']).then((res) => {
  buildProfiles(res.user || null);
  setupUpdaterUI();
});
