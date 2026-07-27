(() => {
  if (window.__np_seek_bridge_installed) return;
  window.__np_seek_bridge_installed = true;

  function getPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const vp = api?.videoPlayer;
      const ids = vp?.getAllPlayerSessionIds?.();
      if (!ids || !ids.length) return null;
      return vp.getVideoPlayerBySessionId(ids[0]);
    } catch (_) {
      return null;
    }
  }

  function seekMs(ms) {
    const player = getPlayer();
    if (!player) return;
    try {
      player.seek(ms);
    } catch (_) {}
  }

  window.addEventListener('np-seek', (e) => {
    const ms = Number(e?.detail?.ms);
    if (!Number.isFinite(ms)) return;
    seekMs(ms);
  });

  // Also expose a global for manual console use if needed.
  window.netflixSeekMs = seekMs;
})();
