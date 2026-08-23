/**
 * Netflix Connect - macOS Native Messaging updater client (protocol v4+)
 * Host: xyz.faredrop.netflixconnect.updater
 *
 * Update sequencing (one button, two native processes):
 *   status → update_helper → status → update_extension → status → reload
 * Never call legacy action "update". Never trust fetch(manifest) alone.
 */

const NC_NATIVE_HOST = 'xyz.faredrop.netflixconnect.updater';
const NC_EXPECTED_EXT_ID = 'lajgengnbhhmlgmfnhhjihceohjklkci';
const NC_MIN_PROTOCOL = 4;
const NC_EXPECTED_EXT_PATH_SUFFIX = '/NetflixConnect/extension';
const NC_UPDATE_ALARM = 'nc-update-check';
const NC_UPDATE_PERIOD_MINUTES = 360;
const NC_INSTALLER_URL = 'https://github.com/stormey2010/netflixupdater';

function ncNativeMessage(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NC_NATIVE_HOST, payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message || 'Native helper not available',
            helperInstalled: false,
            chromeError: chrome.runtime.lastError.message || '',
            extensionId: chrome.runtime.id,
          });
          return;
        }
        const body = response || { success: false, error: 'Empty helper response' };
        body.extensionId = chrome.runtime.id;
        resolve(body);
      });
    } catch (e) {
      resolve({
        success: false,
        error: e.message || String(e),
        helperInstalled: false,
        extensionId: chrome.runtime.id,
      });
    }
  });
}

async function ncUpdaterStatus() {
  return ncNativeMessage({ action: 'status' });
}

async function ncCheckUpdate() {
  return ncNativeMessage({ action: 'check_update' });
}

async function ncUpdateHelper() {
  return ncNativeMessage({ action: 'update_helper' });
}

async function ncUpdateExtension() {
  return ncNativeMessage({ action: 'update_extension' });
}

function ncPathIsCanonical(status) {
  const p = String(status?.extensionPath || '').replace(/\\/g, '/');
  return p.endsWith(NC_EXPECTED_EXT_PATH_SUFFIX) || p.endsWith('/extension');
}

function ncHelperIsCurrent(status) {
  const v = Number(status?.protocolVersion || 0);
  return (
    !!status?.success &&
    status?.helperInstalled !== false &&
    v >= NC_MIN_PROTOCOL &&
    status?.safeUpdate === true &&
    ncPathIsCanonical(status)
  );
}

function ncReloadSafe(status) {
  return (
    ncHelperIsCurrent(status) &&
    status.diskManifestOK === true &&
    !!status.diskManifestVersion &&
    status.reloadSafe !== false
  );
}

function ncDiagnoseHelperError(status) {
  const id = status.extensionId || chrome.runtime.id || '';
  const err = (status.chromeError || status.error || '').toLowerCase();
  const lines = [];

  if (id && id !== NC_EXPECTED_EXT_ID) {
    lines.push(
      `Wrong extension ID (<code>${id}</code>). Expected <code>${NC_EXPECTED_EXT_ID}</code>. ` +
      `Remove the extension and Load unpacked from ~/Library/Application Support/NetflixConnect/extension`
    );
  }

  if (status.helperInstalled !== false && status.success && !ncHelperIsCurrent(status)) {
    lines.push(
      'Updater helper is outdated (need protocol 4+). Re-run <b>Install Netflix Connect.command</b>, then Cmd+Q Chrome.'
    );
    return lines.join(' ');
  }

  if (err.includes('not found') || err.includes('specified native messaging host')) {
    lines.push(
      'Chrome cannot find the native host. Quit Chrome (Cmd+Q), re-run Install Netflix Connect.command, reopen Chrome.'
    );
  } else if (err.includes('forbidden') || err.includes('access')) {
    lines.push('Host found but this extension ID is not allowed. Re-run the installer.');
  } else if (err.includes('exited') || err.includes('native host has exited')) {
    lines.push(
      'Helper crashed (often quarantine). Re-run installer or: ' +
      '<code>xattr -cr ~/Library/Application\\ Support/NetflixConnect/updater</code>'
    );
  } else if (status.error) {
    lines.push(status.error);
  }

  if (!lines.length) {
    lines.push('Helper not reachable. Re-run Install Netflix Connect.command, then Cmd+Q Chrome.');
  }
  return lines.join(' ');
}

/**
 * One-click update: refresh helper in its own process, then update extension
 * in a NEW helper process. Never mutates extension with an outdated in-memory binary.
 */
async function ncRunSafeUpdate() {
  const before = await ncUpdaterStatus();
  if (!before.success || before.helperInstalled === false) {
    return { success: false, error: before.error || 'Helper not installed', phase: 'status' };
  }
  if (Number(before.protocolVersion || 0) < NC_MIN_PROTOCOL) {
    return {
      success: false,
      error: 'Helper protocol too old — re-run Install Netflix Connect.command',
      phase: 'protocol',
      needsInstaller: true,
    };
  }

  // Process A: replace helper binary only, then exit.
  const helperResult = await ncUpdateHelper();
  if (!helperResult.success) {
    // Offline / download failure: continue only if current helper already meets protocol.
    if (!ncHelperIsCurrent(before)) {
      return { success: false, error: helperResult.error || 'Helper update failed', phase: 'update_helper' };
    }
  }

  // Allow OS to finish replacing the executable; next call starts a new process.
  await new Promise((r) => setTimeout(r, 400));

  const mid = await ncUpdaterStatus();
  if (!ncHelperIsCurrent(mid)) {
    return {
      success: false,
      error: mid.error || 'New helper did not report protocol 4 / safeUpdate',
      phase: 'post_helper_status',
      needsInstaller: true,
    };
  }

  // Process B (new binary): overlay extension files only.
  const extResult = await ncUpdateExtension();
  if (!extResult.success) {
    return { ...extResult, phase: 'update_extension' };
  }

  await new Promise((r) => setTimeout(r, 300));
  const after = await ncUpdaterStatus();
  if (!ncReloadSafe(after)) {
    return {
      success: false,
      error: 'Extension files updated but disk verification failed — not reloading',
      phase: 'verify',
      diskManifestOK: after.diskManifestOK,
      extensionPath: after.extensionPath,
      changed: extResult.changed,
    };
  }

  return {
    success: true,
    changed: !!extResult.changed,
    newVersion: after.diskManifestVersion || extResult.newVersion,
    diskManifestOK: true,
    reloadSafe: true,
    extensionPath: after.extensionPath,
    protocolVersion: after.protocolVersion,
    phase: 'done',
  };
}

async function ncMaybeAutoUpdate() {
  // Disabled until protocol-4 architecture is battle-tested.
  return;
}

function ncEnsureUpdateAlarm() {
  chrome.alarms.get(NC_UPDATE_ALARM, (existing) => {
    if (existing) return;
    chrome.alarms.create(NC_UPDATE_ALARM, { periodInMinutes: NC_UPDATE_PERIOD_MINUTES });
  });
}
