/**
 * Netflix Connect - Session gate
 * Page-affecting features run ONLY while connected with a partner.
 * Idle Netflix browsing should be indistinguishable from no extension.
 */

const ncSession = {
  active: false,
  _featuresReady: false,

  isActive() {
    return this.active === true;
  },

  /** Turn on sync/UI hooks when a watch-together session starts. */
  activate(partner = null) {
    if (this.active) {
      if (partner) ncNotifications.setPartner?.(partner);
      return;
    }
    this.active = true;
    console.log('[Netflix Connect] Session active — enabling page hooks');

    ncInjector.init();
    document.documentElement.dispatchEvent(
      new CustomEvent('nc-session', { detail: { active: true }, bubbles: true })
    );

    if (!this._featuresReady) {
      ncSync.init();
      ncShareButton.init();
      ncNavigation.init();
      this._featuresReady = true;
    } else {
      ncSync.setEnabled(true);
      ncShareButton.setEnabled(true);
      ncNavigation.setEnabled(true);
    }

    ncTelemetry.start();
    ncDriftChecker.start();
    ncNotifications.enterConnectedUi(partner);
  },

  /** Tear down every DOM/player hook so Netflix is left alone. */
  deactivate() {
    if (!this.active) {
      ncNotifications.exitConnectedUi();
      return;
    }
    this.active = false;
    console.log('[Netflix Connect] Session ended — disabling page hooks');

    document.documentElement.dispatchEvent(
      new CustomEvent('nc-session', { detail: { active: false }, bubbles: true })
    );

    ncSync.setEnabled(false);
    ncShareButton.setEnabled(false);
    ncNavigation.setEnabled(false);
    ncTelemetry.stop();
    ncDriftChecker.stop();
    ncInjector.teardown();
    ncNotifications.exitConnectedUi();
  },
};
