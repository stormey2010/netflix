// Netflix Connect - background service worker.
// Opens setup on first install and polls the macOS updater quietly.

importScripts('js/updater.js');

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.get(['user'], (result) => {
      if (!result.user) {
        chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
      }
    });
    // Opt into auto-updates when the Mac helper is used.
    chrome.storage.sync.set({ autoInstallUpdates: true });
  }
  ncEnsureUpdateAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ncEnsureUpdateAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== NC_UPDATE_ALARM) return;
  ncMaybeAutoUpdate().catch(() => {});
});

// Ensure alarm exists even if the worker woke without install/startup events.
ncEnsureUpdateAlarm();
