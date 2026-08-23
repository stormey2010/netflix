/**
 * Netflix Connect - Entry Point
 * Boots a light realtime listener for invites/session state.
 * Heavy Netflix page hooks stay off until ncSession.activate().
 */

(() => {
  // Skip sandboxed/child frames to avoid CSP/sandbox errors.
  if (window.top !== window) return;

  console.log('[Netflix Connect] Idle boot (page hooks off until connected)');

  ncTicker.start();
  ncNotifications.init();  // invite toasts only until connected
  ncMessages.init();
  ncUser.setupChangeListener();

  ncUser.load().then(() => {
    ncStream.start(); // needed for invite + connection events
    console.log('[Netflix Connect] Ready as', ncUser.current, '(inactive on page)');
  });
})();
