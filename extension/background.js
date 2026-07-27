// Netflix Connect - background service worker.
// Opens the setup page on first install if no profile is chosen yet.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.sync.get(['user'], (result) => {
    if (!result.user) {
      chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
    }
  });
});
