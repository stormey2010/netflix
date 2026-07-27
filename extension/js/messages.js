/**
 * Netflix Connect - Message Handler
 * Handles messages from popup and background script
 */

const ncMessages = {
  init() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      this.handleMessage(msg, sendResponse);
      return true; // Keep channel open for async response
    });
  },
  
  async handleMessage(msg, sendResponse) {
    try {
      const video = ncGetVideo();

      switch (msg?.type) {
        case 'np.getState':
          if (!video) {
            sendResponse({ ok: true, hasVideo: false, paused: true });
          } else {
            sendResponse({ 
              ok: true, 
              hasVideo: true, 
              paused: !!video.paused, 
              player: ncDescribeVideo(video) 
            });
          }
          break;

        case 'np.localPlay':
          if (video) video.play().catch(() => {});
          sendResponse({ ok: true });
          break;

        case 'np.localPause':
          if (video) video.pause();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'Unknown message.' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  }
};
