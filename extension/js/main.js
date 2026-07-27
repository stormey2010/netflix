/**
 * Netflix Connect - Entry Point
 * Boots all content-script modules in dependency order.
 */

(() => {
  // Skip sandboxed/child frames to avoid CSP/sandbox errors.
  if (window.top !== window) return;

  console.log('[Netflix Connect] Initializing...');

  ncTicker.start();
  ncInjector.init();       // page-bridge (seek hook) + page banner
  ncNotifications.init();  // toast container + stream handlers
  ncSync.init();           // video listeners + inbound commands
  ncShareButton.init();    // detail-modal buttons
  ncMessages.init();       // popup messaging
  ncUser.setupChangeListener();

  ncUser.load().then(() => {
    ncStream.start();      // single unified SSE connection
    ncTelemetry.start();
    ncNavigation.init();
    ncDriftChecker.start();
    console.log('[Netflix Connect] Ready as', ncUser.current);
  });
})();
