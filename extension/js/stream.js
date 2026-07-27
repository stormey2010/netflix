/**
 * Netflix Connect - Event Stream
 *
 * One SSE connection to the server's unified /events/stream. Events carry a
 * `channel` (command, nav, invite, init) and modules register handlers per
 * channel. Replaces the old model of three separate EventSource connections.
 */

const ncStream = {
  sse: null,
  handlers: {},

  on(channel, fn) {
    (this.handlers[channel] ||= []).push(fn);
  },

  start() {
    if (this.sse) this.sse.stop();

    const url = new URL(NC_CONFIG.ENDPOINTS.EVENTS_STREAM);
    url.searchParams.set('channels', 'command,nav,invite');
    if (ncUser.current && ncUser.current !== 'unknown') {
      url.searchParams.set('user', ncUser.current);
    }

    this.sse = ncCreateSSE(url.toString(), (data) => this.dispatch(data), {
      onOpen: () => console.log('[Netflix Connect] Event stream connected'),
    });
    this.sse.start();
  },

  stop() {
    if (this.sse) {
      this.sse.stop();
      this.sse = null;
    }
  },

  restart() {
    this.start();
  },

  dispatch(data) {
    if (!data?.channel || data.channel === 'heartbeat') return;
    // Server filters targeted events, but double-check locally too.
    if (data.target_user && ncUser.current && data.target_user !== ncUser.current) return;
    for (const fn of this.handlers[data.channel] || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(`[Netflix Connect] ${data.channel} handler error:`, e);
      }
    }
  },
};
