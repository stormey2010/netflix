/**
 * Netflix Connect - Script Injection Module
 * Handles injecting page-context scripts
 */

const ncInjector = {
  // Inject the seek hook script
  injectSeekHook() {
    if (!chrome.runtime?.id) return;
    const already = document.querySelector('script[data-np-bridge="seek"]');
    if (already) return;
    
    const s = document.createElement('script');
    s.dataset.npBridge = 'seek';
    try {
      s.src = chrome.runtime.getURL('page-bridge.js');
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {
      s.remove();
    }
  },
  
  // Inject the page UI script
  injectPageUi() {
    if (!chrome.runtime?.id) return;
    const already = document.querySelector('script[data-np-bridge="ui"]');
    if (already) return;
    
    const s = document.createElement('script');
    s.dataset.npBridge = 'ui';
    try {
      s.src = chrome.runtime.getURL('page-ui.js');
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {
      s.remove();
    }
  },
  
  // Initialize injector
  init() {
    this.injectSeekHook();
    this.injectPageUi();
  }
};
