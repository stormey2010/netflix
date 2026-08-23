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
  
  // Initialize injector (only while a session is active)
  init() {
    this.injectSeekHook();
    this.injectPageUi();
  },

  /** Remove page-context UI we added; seek bridge is inert without np-seek events. */
  teardown() {
    document.querySelectorAll('script[data-np-bridge="ui"]').forEach((s) => s.remove());
    document.getElementById('netflix-party-connected-message')?.remove();
    document.documentElement.dispatchEvent(
      new CustomEvent('nc-session', { detail: { active: false }, bubbles: true })
    );
  },
};
