/**
 * Netflix Connect - macOS Native Messaging updater client
 * Host: xyz.faredrop.netflixconnect.updater
 */

const NC_NATIVE_HOST = 'xyz.faredrop.netflixconnect.updater';
const NC_EXPECTED_EXT_ID = 'lajgengnbhhmlgmfnhhjihceohjklkci';
const NC_MIN_PROTOCOL = 3;
const NC_UPDATE_ALARM = 'nc-update-check';
const NC_UPDATE_PERIOD_MINUTES = 360; // 6 hours
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

async function ncRunUpdate() {
  return ncNativeMessage({ action: 'update' });
}

function ncHelperIsCurrent(status) {
  const v = Number(status?.protocolVersion || 0);
  return status?.success && status?.helperInstalled !== false && v >= NC_MIN_PROTOCOL;
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

  if (status.helperInstalled !== false && !ncHelperIsCurrent(status) && status.success) {
    lines.push(
      'Updater helper is outdated and can break Chrome. Re-run <b>Install Netflix Connect.command</b> from the netflixupdater repo once, then Cmd+Q Chrome.'
    );
    return lines.join(' ');
  }

  if (err.includes('not found') || err.includes('specified native messaging host')) {
    lines.push(
      'Chrome cannot find the native host. Quit Chrome fully (Cmd+Q), re-run Install Netflix Connect.command, then reopen Chrome.'
    );
  } else if (err.includes('forbidden') || err.includes('access')) {
    lines.push(
      'Host found but this extension ID is not allowed. Re-run the installer and confirm the ID matches.'
    );
  } else if (err.includes('exited') || err.includes('native host has exited')) {
    lines.push(
      'Helper launched then crashed (often macOS quarantine). Re-run the installer, or run: ' +
      '<code>xattr -cr ~/Library/Application\\ Support/NetflixConnect/updater</code>'
    );
  } else if (status.error) {
    lines.push(status.error);
  }

  if (!lines.length) {
    lines.push('Helper not reachable. Re-run Install Netflix Connect.command, then Cmd+Q Chrome and reopen.');
  }
  return lines.join(' ');
}

async function ncExtensionFilesOk() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.name === 'Netflix Connect' && !!data?.version;
  } catch {
    return false;
  }
}

async function ncSafeReload() {
  if (!(await ncExtensionFilesOk())) {
    return false;
  }
  try {
    chrome.runtime.reload();
    return true;
  } catch {
    return false;
  }
}

async function ncIsNetflixPlaying() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.netflix.com/*' });
    for (const tab of tabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'np.getState' });
        if (res?.hasVideo && res.paused === false) return true;
      } catch {
        // Content script may be absent on browse pages.
      }
    }
  } catch {
    // ignore
  }
  return false;
}

async function ncMaybeAutoUpdate() {
  // Never auto-install/reload unpacked extensions — a bad helper used to
  // delete Chrome's load path. Updates are one-click manual only.
  return;
}

function ncEnsureUpdateAlarm() {
  chrome.alarms.get(NC_UPDATE_ALARM, (existing) => {
    if (existing) return;
    chrome.alarms.create(NC_UPDATE_ALARM, { periodInMinutes: NC_UPDATE_PERIOD_MINUTES });
  });
}
