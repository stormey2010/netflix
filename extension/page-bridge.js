(() => {
  if (window.__np_seek_bridge_installed) return;
  window.__np_seek_bridge_installed = true;

  function getPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const vp = api?.videoPlayer;
      const ids = vp?.getAllPlayerSessionIds?.();
      if (!ids || !ids.length) return null;
      for (let i = ids.length - 1; i >= 0; i--) {
        const player = vp.getVideoPlayerBySessionId(ids[i]);
        if (player) return player;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function getVideo() {
    return document.querySelector('video');
  }

  function seekMs(ms) {
    const player = getPlayer();
    if (!player) return;
    try {
      player.seek(ms);
    } catch (_) {}
  }

  function playPlayer() {
    const player = getPlayer();
    if (player) {
      try {
        if (typeof player.play === 'function') {
          player.play();
          return;
        }
      } catch (_) {}
    }
    const v = getVideo();
    if (v) v.play().catch(() => {});
  }

  function pausePlayer() {
    const player = getPlayer();
    if (player) {
      try {
        if (typeof player.pause === 'function') {
          player.pause();
          return;
        }
      } catch (_) {}
    }
    const v = getVideo();
    if (v) {
      try { v.pause(); } catch (_) {}
    }
  }

  window.addEventListener('np-seek', (e) => {
    const ms = Number(e?.detail?.ms);
    if (!Number.isFinite(ms)) return;
    seekMs(ms);
  });

  window.addEventListener('np-play', () => playPlayer());
  window.addEventListener('np-pause', () => pausePlayer());

  window.netflixSeekMs = seekMs;
  window.netflixPlay = playPlayer;
  window.netflixPause = pausePlayer;
})();
