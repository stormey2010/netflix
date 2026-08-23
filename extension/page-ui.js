// Netflix Connect - page-context UI: "Watching Together" banner shown while
// the player chrome is active. Runs in the page context (injected).
// Only active when content script dispatches nc-session { active: true }.

(() => {
  if (window.__np_ui_installed) return;
  window.__np_ui_installed = true;

  const HELPER_ID = 'netflix-party-connected-message';
  let observer = null;
  let target = null;
  let sessionActive = false;
  let findTimer = null;

  function ensureHelper() {
    let el = document.getElementById(HELPER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = HELPER_ID;
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:8px;height:8px;background:#e50914;border-radius:50%;animation:npPulse 1.6s infinite;"></div>
          <span>Watching Together</span>
        </div>
      `;
      el.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:20px',
        'transform:translateX(-50%) translateY(-10px)',
        'padding:11px 20px',
        'border-radius:999px',
        'background:rgba(15,15,18,0.82)',
        'backdrop-filter:blur(14px)',
        '-webkit-backdrop-filter:blur(14px)',
        'border:1px solid rgba(255,255,255,0.09)',
        'color:#ffffff',
        'font-size:13px',
        'font-weight:600',
        'font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'letter-spacing:0.6px',
        'z-index:1000000',
        'pointer-events:none',
        'box-shadow:0 8px 30px rgba(0,0,0,0.45)',
        'opacity:0',
        'transition:opacity 0.3s ease,transform 0.3s ease',
      ].join(';');

      if (!document.getElementById('np-ui-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'np-ui-pulse-style';
        style.textContent = `
          @keyframes npPulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.45; transform: scale(1.25); }
          }
        `;
        document.head.appendChild(style);
      }
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function setVisible(isVisible) {
    if (!sessionActive) {
      const el = document.getElementById(HELPER_ID);
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(-10px)';
      }
      return;
    }
    const el = ensureHelper();
    el.style.opacity = isVisible ? '1' : '0';
    el.style.transform = isVisible
      ? 'translateX(-50%) translateY(0)'
      : 'translateX(-50%) translateY(-10px)';
  }

  function evaluate() {
    if (!sessionActive || !target) {
      setVisible(false);
      return;
    }
    setVisible(target.classList.contains('active'));
  }

  function attachObserver() {
    if (observer || !target) return;
    observer = new MutationObserver(evaluate);
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    evaluate();
  }

  function detachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    target = null;
    clearTimeout(findTimer);
    findTimer = null;
    document.getElementById(HELPER_ID)?.remove();
  }

  function findTargetAndWatch(attempts = 0) {
    if (!sessionActive) return;
    if (target) return;
    target = document.querySelector('div[data-uia="player"]');
    if (target) {
      attachObserver();
      return;
    }
    if (attempts > 20) return;
    findTimer = setTimeout(() => findTargetAndWatch(attempts + 1), 250);
  }

  function setSessionActive(active) {
    sessionActive = !!active;
    if (sessionActive) {
      findTargetAndWatch();
    } else {
      detachObserver();
    }
  }

  document.documentElement.addEventListener('nc-session', (e) => {
    setSessionActive(!!e.detail?.active);
  });
})();
