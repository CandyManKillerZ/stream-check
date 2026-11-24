'use strict';
// Platform adapter — the only file that knows where Stream Check is running:
//   windows : Wails shell (desktop/native.go, pair.go)   window.go.main.App.*
//   android : Capacitor shell (NetProbe Java plugin)     window.Capacitor.Plugins.*
//   browser : plain page for UI development (CORS will block most checks)
// Every function resolves (never rejects); failures come back as `error` text.

const APP_VERSION = '1.3.0';

const Native = (() => {
  const wailsApp = () => window.go?.main?.App;
  const cap = () => window.Capacitor;
  const isAndroid = () => !!cap()?.isNativePlatform?.();
  const speedListeners = new Map();

  // Turn Java / browser exception text into the same short phrases Go uses.
  function friendly(e) {
    const s = String(e?.message || e || 'failed');
    if (/UnknownHost|Unable to resolve|ENOTFOUND|getaddrinfo/i.test(s)) return 'domain not found (DNS)';
    if (/timed? ?out|Timeout/i.test(s)) return 'timed out';
    if (/refused/i.test(s)) return 'connection refused';
    if (/reset/i.test(s)) return 'connection reset';
    if (/SSL|TLS|certificate|handshake/i.test(s)) return 'secure connection failed (TLS)';
    if (/Failed to fetch|NetworkError/i.test(s)) return 'blocked or unreachable';
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  const windows = {
    name: 'windows',
    init() {
      window.runtime.EventsOn('speed', (s) => speedListeners.get(s.id)?.(s));
      window.runtime.EventsOn('pair', (e) => pairListeners.forEach((cb) => cb(e)));
    },
    http: (o) => wailsApp().HTTP({
      method: o.method || 'GET', url: o.url, timeoutMs: o.timeoutMs || 15000,
      headers: { ...(o.json ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}) },
      body: o.json ? JSON.stringify(o.json) : o.body || '',
    }),
    ping: (host, port, timeoutMs) => wailsApp().TCPPing(host, port, timeoutMs),
    async speed(id, url, seconds, onProgress) {
      speedListeners.set(id, onProgress);
      try { return await wailsApp().SpeedTest(id, url, seconds); } finally { speedListeners.delete(id); }
    },
    get: (k) => wailsApp().StoreGet(k),
    set: (k, v) => wailsApp().StoreSet(k, v || ''),
    open: (u) => wailsApp().OpenURL(u),
    deviceName: async () => 'PC',
    onLink() {},
    // Wi-Fi pairing — this PC hands its sign-ins to a phone (desktop/pair.go)
    startPairing: () => wailsApp().StartPairing(),
    answerPairing: (allow) => wailsApp().AnswerPairing(allow),
    stopPairing: () => wailsApp().StopPairing(),
  };

  const android = {
    name: 'android',
    init() {},
    async http(o) {
      const t0 = performance.now();
      try {
        const r = await cap().Plugins.CapacitorHttp.request({
          url: o.url, method: o.method || 'GET',
          headers: { 'User-Agent': `StreamCheck/${APP_VERSION} (Android)`, ...(o.json ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}) },
          data: o.json || o.body || undefined,
          connectTimeout: o.timeoutMs || 15000, readTimeout: o.timeoutMs || 15000,
          responseType: 'text',
        });
        let body = r.data;
        if (typeof body !== 'string') body = JSON.stringify(body ?? '');
        return { status: r.status, body, ms: Math.round(performance.now() - t0), error: '' };
      } catch (e) {
        return { status: 0, body: '', ms: Math.round(performance.now() - t0), error: friendly(e) };
      }
    },
    async ping(host, port, timeoutMs) {
      try { return await cap().Plugins.NetProbe.tcpPing({ host, port, timeout: timeoutMs }); }
      catch (e) { return { ms: -1, error: friendly(e) }; }
    },
    async speed(id, url, seconds, onProgress) {
      const NP = cap().Plugins.NetProbe;
      const h = await NP.addListener('speed', (s) => { if (s.id === id) onProgress(s); });
      try { return await NP.speedTest({ id, url, seconds }); }
      catch (e) { return { id, mbps: 0, mb: 0, error: friendly(e) }; }
      finally { h.remove(); }
    },
    async get(k) {
      try { return (await cap().Plugins.NetProbe.secureGet({ key: k })).value || ''; } catch { return ''; }
    },
    set: (k, v) => cap().Plugins.NetProbe.secureSet({ key: k, value: v || '' }),
    open: (u) => cap().Plugins.NetProbe.openUrl({ url: u }),
    async deviceName() {
      try { return (await cap().Plugins.NetProbe.deviceName()).name || 'Android phone'; } catch { return 'Android phone'; }
    },
    // streamcheck://pair?d=… links (from the QR code's web page) open the app.
    onLink(cb) {
      const App = cap().Plugins.App;
      if (!App) return;
      App.addListener('appUrlOpen', (e) => e?.url && cb(e.url));
      App.getLaunchUrl?.().then((r) => r?.url && cb(r.url)).catch(() => {});
    },
  };

  const browser = {
    name: 'browser',
    init() {},
    async http(o) {
      const t0 = performance.now();
      try {
        const r = await fetch(o.url, {
          method: o.method || 'GET', signal: AbortSignal.timeout(o.timeoutMs || 15000),
          headers: { ...(o.json ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}) },
          body: o.json ? JSON.stringify(o.json) : o.body || undefined,
        });
        return { status: r.status, body: await r.text(), ms: Math.round(performance.now() - t0), error: '' };
      } catch (e) { return { status: 0, body: '', ms: Math.round(performance.now() - t0), error: friendly(e) }; }
    },
    async ping() { return { ms: -1, error: 'not available in a browser' }; },
    async speed(id) { return { id, mbps: 0, mb: 0, error: 'not available in a browser' }; },
    get: async (k) => localStorage.getItem('sc_' + k) || '',
    set: async (k, v) => (v ? localStorage.setItem('sc_' + k, v) : localStorage.removeItem('sc_' + k)),
    open: (u) => window.open(u, '_blank'),
    deviceName: async () => 'Browser',
    onLink() {},
  };

  const pairListeners = new Set();
  let impl = null;
  async function ready() {
    if (impl) return impl;
    for (let i = 0; i < 200; i++) {
      if (wailsApp() && window.runtime?.EventsOn) { impl = windows; break; }
      if (isAndroid() && cap().Plugins?.NetProbe) { impl = android; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    impl = impl || browser;
    impl.init();
    return impl;
  }

  return {
    ready,
    get name() { return impl?.name || 'unknown'; },
    http: (o) => impl.http(o),
    ping: (h, p, t) => impl.ping(h, p, t),
    speed: (id, u, s, cb) => impl.speed(id, u, s, cb),
    get: (k) => impl.get(k),
    set: (k, v) => impl.set(k, v),
    open: (u) => { if (/^https?:\/\//.test(u)) impl.open(u); },
    deviceName: () => impl.deviceName(),
    onLink: (cb) => impl.onLink(cb),
    canHostPairing: () => !!impl?.startPairing,
    startPairing: () => impl.startPairing(),
    answerPairing: (allow) => impl.answerPairing(allow),
    stopPairing: () => impl.stopPairing?.(),
    onPair: (cb) => pairListeners.add(cb),
  };
})();
