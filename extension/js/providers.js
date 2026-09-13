/**
 * Streaming provider registry and player adapters.
 *
 * Every provider is isolated behind this small interface. A broken player
 * integration is contained to its tab and cannot break the shared stream or
 * another provider's adapter.
 */

const NC_PLAYBACK_CONTEXT = {
  CONTENT: 'content',
  AD: 'ad',
  INTRO: 'intro',
  RECAP: 'recap',
  CREDITS: 'credits',
  PREPLAY: 'preplay',
  UP_NEXT: 'up_next',
  STILL_WATCHING: 'still_watching',
  BUFFERING: 'buffering',
  SEEKING: 'seeking',
  ERROR: 'error',
  MEDIA_CHANGED: 'media_changed',
  AUXILIARY_VIDEO: 'auxiliary_video',
  UNKNOWN_INTERSTITIAL: 'unknown_interstitial',
};

function ncVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect?.();
  return style.display !== 'none' && style.visibility !== 'hidden' &&
    Number(style.opacity || 1) > 0 && (!rect || (rect.width > 0 && rect.height > 0));
}

function ncText(el) {
  return String(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim();
}

function ncVisibleAny(selectors) {
  return selectors.some((selector) => {
    try { return [...document.querySelectorAll(selector)].some(ncVisible); } catch { return false; }
  });
}

function ncScoreVideo(video, preferredSelectors = []) {
  if (!video || !video.isConnected) return -Infinity;
  let score = 0;
  const rect = video.getBoundingClientRect?.();
  if (ncVisible(video)) score += 8;
  if (rect && rect.width > 240 && rect.height > 135) score += 8;
  if (video.readyState >= 2) score += 5;
  if (Number.isFinite(video.duration)) score += 4;
  if (video.currentSrc || video.src) score += 2;
  if (video.seekable?.length) score += 2;
  for (const selector of preferredSelectors) {
    try { if (video.matches(selector)) score += 12; } catch {}
  }
  return score;
}

function ncBestVideo(candidates, preferredSelectors = []) {
  return [...new Set(candidates)].map((video) => ({
    video,
    score: ncScoreVideo(video, preferredSelectors),
  })).sort((a, b) => b.score - a.score)[0]?.video || null;
}

function ncUrlId(patterns) {
  const url = window.location.href;
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function ncGenericTitle(providerName) {
  const selectors = [
    '[data-testid="title"]', '[data-testid="video-title"]',
    'h1[data-uia="video-title"]', 'h1', '[class*="title" i]',
  ];
  for (const selector of selectors) {
    const node = [...document.querySelectorAll(selector)].find((el) => ncVisible(el) && ncText(el));
    if (node) return ncText(node).replace(/\s+/g, ' ').slice(0, 180);
  }
  const title = document.title.replace(/\s*[|·-].*$/, '').trim();
  return title && !/^watch\b/i.test(title) ? title.slice(0, 180) : `${providerName} playback`;
}

function ncGenericContext(video, provider) {
  if (!video) return { kind: NC_PLAYBACK_CONTEXT.MEDIA_CHANGED, blocking: true, confidence: 1 };
  if (video.error) return { kind: NC_PLAYBACK_CONTEXT.ERROR, blocking: true, confidence: 1 };
  if (video.seeking) return { kind: NC_PLAYBACK_CONTEXT.SEEKING, blocking: true, confidence: 1 };
  if (!video.paused && video.readyState < 2) return { kind: NC_PLAYBACK_CONTEXT.BUFFERING, blocking: true, confidence: 0.8 };
  if (provider.isAdActive?.()) return { kind: NC_PLAYBACK_CONTEXT.AD, blocking: true, confidence: 0.95 };
  if (provider.isBlockingOverlayActive?.()) return { kind: NC_PLAYBACK_CONTEXT.STILL_WATCHING, blocking: true, confidence: 0.9 };
  if (provider.isInterstitialActive?.()) return { kind: NC_PLAYBACK_CONTEXT.UNKNOWN_INTERSTITIAL, blocking: true, confidence: 0.7 };
  return { kind: NC_PLAYBACK_CONTEXT.CONTENT, blocking: false, confidence: 1 };
}

function ncNetflixVideo() {
  return document.querySelector('video');
}

function ncYouTubePlayer() {
  return document.getElementById('movie_player');
}

function ncYouTubeVideo() {
  const player = ncYouTubePlayer();
  return player?.querySelector('video.html5-main-video') ||
    ncBestVideo(document.querySelectorAll('#movie_player video'), ['.html5-main-video']);
}

function ncPrimeVideo() {
  const scoped = document.querySelectorAll(
    '#dv-web-player video, [id^="dv-web-player"] video, .atvwebplayersdk-video-surface'
  );
  const candidates = scoped.length ? scoped : document.querySelectorAll('video');
  return ncBestVideo(candidates, ['.atvwebplayersdk-video-surface']);
}

function ncHuluVideo() {
  const content = document.querySelector('#content-video-player');
  return content?.matches?.('video') ? content : content?.querySelector('video') || null;
}

function ncPeacockVideo() {
  return document.querySelector('#core-video-shaka') ||
    ncBestVideo(document.querySelectorAll('video'), ['#core-video-shaka']);
}

function ncDisneyVideo() {
  return document.querySelector('#hivePlayer1') ||
    document.querySelector('disney-web-player video.hive-video') ||
    ncBestVideo(document.querySelectorAll('disney-web-player video, video'), ['.hive-video']);
}

function ncHuluDuration(video) {
  if (Number.isFinite(video?.duration)) return video.duration;
  const slider = document.querySelector('.Timeline__slider[role="slider"]');
  const duration = Number(slider?.getAttribute('aria-valuemax'));
  return Number.isFinite(duration) ? duration : null;
}

function ncHuluSeek(video, seconds) {
  const target = Math.max(0, Number(seconds));
  const duration = ncHuluDuration(video);
  const range = video?.seekable;
  const inSafeRange = range?.length && target >= range.start(0) && target <= Math.max(range.start(0), range.end(range.length - 1) - 0.25);
  if (inSafeRange) {
    video.currentTime = target;
    return true;
  }
  const slider = document.querySelector('.Timeline__slider[role="slider"]');
  if (!slider || !Number.isFinite(duration) || !ncVisible(slider)) return false;
  const ratio = Math.min(1, Math.max(0, target / duration));
  const rect = slider.getBoundingClientRect();
  const clientX = rect.left + rect.width * ratio;
  const eventInit = { bubbles: true, cancelable: true, clientX, clientY: rect.top + rect.height / 2 };
  try {
    slider.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    slider.dispatchEvent(new MouseEvent('mousedown', eventInit));
    slider.dispatchEvent(new PointerEvent('pointerup', eventInit));
    slider.dispatchEvent(new MouseEvent('mouseup', eventInit));
    slider.dispatchEvent(new MouseEvent('click', eventInit));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch { return false; }
}

function ncYouTubeApi() {
  const player = ncYouTubePlayer();
  return player && typeof player.getCurrentTime === 'function' ? player : null;
}

const NC_PROVIDER_DEFS = {
  netflix: {
    key: 'netflix', name: 'Netflix', hosts: ['netflix.com'], softRate: true,
    findVideo: ncNetflixVideo,
    mediaId: () => ncUrlId([/\/watch\/([^/?#]+)/i]),
    pageType: () => window.location.pathname.includes('/watch/') ? 'watch' :
      window.location.pathname.includes('/browse') || window.location.pathname.includes('/title/') ? 'browse' :
      window.location.pathname.includes('/search') ? 'search' : 'other',
    seek: (_video, seconds) => window.dispatchEvent(new CustomEvent('np-seek', { detail: { ms: Number(seconds) * 1000 } })),
    play: () => window.dispatchEvent(new CustomEvent('np-play')),
    pause: () => window.dispatchEvent(new CustomEvent('np-pause')),
    isAdActive: () => ncVisibleAny(['.ad-showing', '[data-uia="player-ad"]', '[data-uia*="advertisement" i]']),
    segment: () => {
      if (ncVisibleAny(['button[data-uia="player-skip-intro"]'])) return 'intro';
      if (ncVisibleAny(['button[data-uia="player-skip-recap"]'])) return 'recap';
      return null;
    },
  },
  youtube: {
    key: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be'], softRate: false,
    findVideo: ncYouTubeVideo,
    mediaId: () => ncYouTubeApi()?.getVideoData?.()?.video_id || ncUrlId([/[?&]v=([^&#]+)/i, /youtu\.be\/([^/?#]+)/i]),
    pageType: () => window.location.pathname === '/watch' ? 'watch' : window.location.pathname.startsWith('/results') ? 'search' : 'browse',
    seek: (video, seconds) => { const p = ncYouTubeApi(); if (p) p.seekTo(Number(seconds), true); else video.currentTime = Number(seconds); },
    play: (video) => { const p = ncYouTubeApi(); return p ? p.playVideo() : video.play(); },
    pause: (video) => { const p = ncYouTubeApi(); return p ? p.pauseVideo() : video.pause(); },
    getTitle: () => document.querySelector('#title h1, h1.ytd-watch-metadata')?.textContent?.trim() || ncGenericTitle('YouTube'),
    isAdActive: () => ncYouTubePlayer()?.classList.contains('ad-showing') || ncYouTubePlayer()?.classList.contains('ad-interrupting'),
  },
  prime: {
    key: 'prime', name: 'Prime Video', hosts: ['primevideo.com'], softRate: false,
    findVideo: ncPrimeVideo,
    mediaId: () => ncUrlId([/\/detail\/([^/?#]+)/i, /\/watch\/([^/?#]+)/i]),
    pageType: () => /\/(detail|watch)\//i.test(window.location.pathname) ? 'watch' : 'browse',
    seek: (video, seconds) => { video.currentTime = Number(seconds); },
    isAdActive: () => ncVisibleAny(['[class*="atvwebplayersdk-ad-timer" i]']),
    isInterstitialActive: () => ncVisibleAny(['.atvwebplayersdk-skipelement-button', '.skipelement-button', '[class*="nextupcard-button" i]']),
    segment: () => {
      const node = [...document.querySelectorAll('.atvwebplayersdk-skipelement-button, .skipelement-button, [class*="skipelement" i]')].find(ncVisible);
      const text = ncText(node).toLowerCase();
      return text.includes('recap') ? 'recap' : text.includes('credit') ? 'credits' : node ? 'intro' : null;
    },
  },
  hulu: {
    key: 'hulu', name: 'Hulu', hosts: ['hulu.com'], softRate: false,
    findVideo: ncHuluVideo,
    mediaId: () => ncUrlId([/\/watch\/([^/?#]+)/i, /\/movie\/([^/?#]+)/i, /\/series\/([^/?#]+)/i]),
    pageType: () => /\/(watch|movie|series)\//i.test(window.location.pathname) ? 'watch' : 'browse',
    duration: ncHuluDuration,
    seek: ncHuluSeek,
    isAdActive: () => ncVisibleAny(['#ad-video-player', '.AdPlayer:not(.AdPlayer--hidden)']),
    isInterstitialActive: () => ncVisibleAny(['#intro-video-player', '.IntroPlayer:not(.IntroPlayer--hidden)', '[data-automationid*="end-card" i]']),
    isBlockingOverlayActive: () => ncVisibleAny(['.long-time-tips__title']),
    segment: () => {
      const node = [...document.querySelectorAll('.SkipButton, [data-automationid*="skip" i]')].find(ncVisible);
      const text = ncText(node).toLowerCase();
      return text.includes('recap') ? 'recap' : text.includes('credit') ? 'credits' : node ? 'intro' : null;
    },
  },
  peacock: {
    key: 'peacock', name: 'Peacock', hosts: ['peacocktv.com'], softRate: true,
    findVideo: ncPeacockVideo,
    mediaId: () => ncUrlId([/\/watch\/([^/?#]+)/i, /\/stream\/([^/?#]+)/i]),
    pageType: () => /\/(watch|stream)\//i.test(window.location.pathname) ? 'watch' : 'browse',
    seek: (video, seconds) => { video.currentTime = Number(seconds); },
    isAdActive: () => ncVisibleAny(['.shaka-client-side-ad-container[ad-active="true"]', '.shaka-server-side-ad-container', '.shaka-ad-container', '[data-testid*="advertisement" i]', '[data-testid*="commercial" i]']),
    isInterstitialActive: () => ncVisibleAny(['[data-testid*="skip-intro" i]', '[data-testid*="up-next" i]']),
    segment: () => {
      const node = [...document.querySelectorAll('[data-testid*="skip" i], button')].find((el) => ncVisible(el) && /skip\s+(intro|recap)|intro|recap/i.test(ncText(el)));
      const text = ncText(node).toLowerCase();
      return text.includes('recap') ? 'recap' : node ? 'intro' : null;
    },
  },
  disney: {
    key: 'disney', name: 'Disney+', hosts: ['disneyplus.com'], softRate: false,
    findVideo: ncDisneyVideo,
    mediaId: () => ncUrlId([/\/video\/([^/?#]+)/i, /\/movies\/[^/?#]+\/([^/?#]+)/i, /\/series\/[^/?#]+\/([^/?#]+)/i]) || window.location.pathname,
    pageType: () => /\/(video|movies|series)\//i.test(window.location.pathname) ? 'watch' : 'browse',
    seek: (video, seconds) => { video.currentTime = Number(seconds); },
    isAdActive: () => ncVisibleAny(['ad-badge-overlay[aria-hidden="false"]', 'ad-badge-overlay:not([hidden])']),
    isInterstitialActive: () => ncVisibleAny(['skip-overlay:not([hidden])', 'preplay-overlay:not([hidden])', 'up-next-lite-v1:not([hidden])', 'end-card-overlay:not([hidden])']),
    isBlockingOverlayActive: () => ncVisibleAny(['inactivity-overlay:not([hidden])']),
    segment: () => {
      const node = [...document.querySelectorAll('skip-overlay button, skip-overlay')].find(ncVisible);
      const text = ncText(node).toLowerCase();
      return text.includes('recap') ? 'recap' : text.includes('credit') ? 'credits' : node ? 'intro' : null;
    },
  },
};

function ncProviderForHost(hostname = window.location.hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return Object.values(NC_PROVIDER_DEFS).find((provider) =>
    provider.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  ) || null;
}

function ncCurrentProvider() {
  return ncProviderForHost();
}

function ncProviderAdapter() {
  return ncCurrentProvider() || NC_PROVIDER_DEFS.netflix;
}

function ncProviderKey() {
  return ncCurrentProvider()?.key || null;
}

function ncProviderName() {
  return ncCurrentProvider()?.name || 'Unsupported site';
}

function ncProviderSupportsSoftSync() {
  return !!ncCurrentProvider()?.softRate;
}

function ncSetPlaybackRate(video, rate) {
  const provider = ncProviderAdapter();
  try {
    if (provider.setPlaybackRate) return provider.setPlaybackRate(video, rate);
    video.playbackRate = rate;
  } catch (e) {
    console.warn(`[Streaming Connect] ${provider.name} rate change failed:`, e);
  }
}

function ncGetPlaybackContext(video = ncGetVideo()) {
  const provider = ncProviderAdapter();
  return ncGenericContext(video, provider);
}

function ncProviderTitle() {
  const provider = ncProviderAdapter();
  return (provider.getTitle?.() || ncGenericTitle(provider.name)).replace(/\s+/g, ' ').trim().slice(0, 180);
}
