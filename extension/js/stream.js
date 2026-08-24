/** WebSocket-first realtime transport with an automatic SSE fallback. */
const ncStream = {
  ws: null,
  sse: null,
  handlers: {},
  stopped: true,
  retryMs: NC_CONFIG.INITIAL_RETRY_MS,
  reconnectTimer: null,
  fallbackTimer: null,
  pingTimer: null,
  serverOffsetMs: 0,
  rttMs: null,
  seq: 0,
  streamId: null,

  on(channel, fn) {
    (this.handlers[channel] ||= []).push(fn);
  },

  _url(endpoint) {
    const url = new URL(endpoint);
    url.searchParams.set('channels', 'command,nav,invite');
    url.searchParams.set('api_key', NC_CONFIG.API_KEY);
    if (ncUser.current && ncUser.current !== 'unknown') url.searchParams.set('user', ncUser.current);
    return url;
  },

  start() {
    this.stop();
    this.stopped = false;
    this.retryMs = NC_CONFIG.INITIAL_RETRY_MS;
    this.streamId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.seq = 0;
    this._connectWebSocket();
  },

  _connectWebSocket() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    const url = this._url(NC_CONFIG.ENDPOINTS.EVENTS_WS);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    // Only fall back to SSE if WS has not opened — never run both live.
    this.fallbackTimer = setTimeout(() => {
      if (this.stopped || this.ws?.readyState === WebSocket.OPEN) return;
      this._startSSE();
    }, NC_CONFIG.WS_FALLBACK_DELAY_MS);

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      clearTimeout(this.fallbackTimer);
      this._stopSSE();
      this.retryMs = NC_CONFIG.INITIAL_RETRY_MS;
      this._ping();
      this.pingTimer = setInterval(() => this._ping(), NC_CONFIG.WS_PING_INTERVAL_MS);
      console.log('[Netflix Connect] Realtime WebSocket connected');
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data || '{}');
        if (data.type === 'pong') this._handlePong(data);
        else this.dispatch(data);
      } catch {}
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.fallbackTimer);
      if (this.stopped) return;
      this._startSSE();
      const delay = Math.min(this.retryMs, NC_CONFIG.MAX_RETRY_MS);
      this.retryMs = Math.min(this.retryMs * 2, NC_CONFIG.MAX_RETRY_MS);
      this.reconnectTimer = setTimeout(() => this._connectWebSocket(), delay);
    };
  },

  _startSSE() {
    if (this.stopped || this.sse || this.ws?.readyState === WebSocket.OPEN) return;
    const url = this._url(NC_CONFIG.ENDPOINTS.EVENTS_STREAM);
    this.sse = ncCreateSSE(url.toString(), (data) => this.dispatch(data), {
      onOpen: () => console.log('[Netflix Connect] SSE fallback connected'),
    });
    this.sse.start();
  },

  _stopSSE() {
    if (!this.sse) return;
    this.sse.stop();
    this.sse = null;
  },

  _ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'ping', client_sent_ms: Date.now() }));
    }
  },

  _handlePong(data) {
    const receivedAt = Date.now();
    const sentAt = Number(data.client_sent_ms);
    const serverReceived = Number(data.server_received_ms);
    const serverSent = Number(data.server_sent_ms);
    if (![sentAt, serverReceived, serverSent].every(Number.isFinite)) return;
    const rtt = Math.max(0, receivedAt - sentAt - (serverSent - serverReceived));
    const offset = ((serverReceived - sentAt) + (serverSent - receivedAt)) / 2;
    const firstSample = this.rttMs === null;
    this.rttMs = firstSample ? rtt : this.rttMs * 0.75 + rtt * 0.25;
    this.serverOffsetMs = firstSample ? offset : this.serverOffsetMs * 0.75 + offset * 0.25;
  },

  wrapSync(payload) {
    this.seq += 1;
    return {
      ...payload,
      event_id: `${this.streamId}:${this.seq}`,
      stream_id: this.streamId,
      seq: this.seq,
      client_sent_ms: Date.now(),
    };
  },

  sendSync(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    const envelope = payload.event_id ? payload : this.wrapSync(payload);
    this.ws.send(JSON.stringify({ type: 'sync', ...envelope }));
    return true;
  },

  estimatedEventAgeMs(data) {
    const received = Number(data.server_received_ms);
    if (Number.isFinite(received) && this.rttMs !== null) {
      return Math.max(0, Date.now() + this.serverOffsetMs - received);
    }
    const sent = Number(data.client_sent_ms);
    if (Number.isFinite(sent)) return Math.max(0, Date.now() - sent);
    if (Number.isFinite(received)) {
      return Math.max(0, Date.now() + this.serverOffsetMs - received);
    }
    return 0;
  },

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.fallbackTimer);
    clearInterval(this.pingTimer);
    this._stopSSE();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  },
  restart() { this.start(); },

  dispatch(data) {
    if (!data?.channel || data.channel === 'heartbeat') return;
    if (this.rttMs === null && Number.isFinite(Number(data.server_sent_ms))) {
      this.serverOffsetMs = Number(data.server_sent_ms) - Date.now();
    }
    if (data.target_user && ncUser.current && data.target_user !== ncUser.current) return;
    for (const fn of this.handlers[data.channel] || []) {
      try { fn(data); }
      catch (e) { console.error(`[Netflix Connect] ${data.channel} handler error:`, e); }
    }
  },
};
