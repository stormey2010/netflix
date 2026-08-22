/**
 * Netflix Connect - macOS Native Messaging updater client
 * Host: xyz.faredrop.netflixconnect.updater
 */

const NC_NATIVE_HOST = 'xyz.faredrop.netflixconnect.updater';
const NC_UPDATE_ALARM = 'nc-update-check';
const NC_UPDATE_PERIOD_MINUTES = 360; // 6 hours

function ncNativeMessage(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NC_NATIVE_HOST, payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message || 'Native helper not available',
            helperInstalled: false,
          });
          return;
        }
        resolve(response || { success: false, error: 'Empty helper response' });
      });
    } catch (e) {
      resolve({ success: false, error: e.message || String(e), helperInstalled: false });
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
  const { autoInstallUpdates } = await chrome.storage.sync.get({ autoInstallUpdates: true });
  if (!autoInstallUpdates) return;

  const check = await ncCheckUpdate();
  if (!check.success || !check.changed) return;

  if (await ncIsNetflixPlaying()) {
    // Defer until next alarm while playback is active.
    return;
  }

  const result = await ncRunUpdate();
  if (result.success && result.changed) {
    chrome.runtime.reload();
  }
}

function ncEnsureUpdateAlarm() {
  chrome.alarms.get(NC_UPDATE_ALARM, (existing) => {
    if (existing) return;
    chrome.alarms.create(NC_UPDATE_ALARM, { periodInMinutes: NC_UPDATE_PERIOD_MINUTES });
  });
}

// Shared by popup + service worker when this file is loaded.
if (typeof window === 'undefined' && typeof chrome !== 'undefined' && chrome.alarms) {
  // Loaded as a service-worker importScripts module marker — background.js wires alarms.
}
