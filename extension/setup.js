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
      label: 'Retry',
      disabled: false,
      detail: `Version <b>${localVersion}</b> · ID <code>${id}</code><br>${diagnosis}`,
    });
    $('updateBtn').onclick = () => refreshUpdater();
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
  setUpdateUI({
    label: 'Reloading…',
    disabled: true,
    detail: `Updated to <b>${result.newVersion || 'latest'}</b> — reloading extension…`,
  });
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch {
      setUpdateUI({
        label: 'Open extensions',
        disabled: false,
        detail: 'Files updated. Open chrome://extensions and click Reload on Netflix Connect.',
      });
      $('updateBtn').onclick = () => chrome.tabs.create({ url: 'chrome://extensions' });
    }
  }, 600);
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

$('closeBtn').addEventListener('click', () => window.close());

chrome.storage.sync.get(['user']).then((res) => {
  buildProfiles(res.user || null);
  setupUpdaterUI();
});
