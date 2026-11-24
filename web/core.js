'use strict';
// Stream Check core — every check, shared by the Windows and Android apps.
// Talks to the network only through Native (platform.js).

const Core = (() => {
  const TORBOX_STATUS = 'https://status.torbox.app';
  const TORBOX_API = 'https://api.torbox.app';
  const TEST_TITLE = { type: 'movie', id: 'tt0111161', name: 'Shawshank' };

  // ---------------------------------------------------------------- http helpers
  async function get(url, { headers, timeoutMs = 15000 } = {}) {
    const r = await Native.http({ url, headers, timeoutMs });
    r.ok = !r.error && r.status >= 200 && r.status < 300;
    r.why = r.error || `HTTP ${r.status}`;
    try { r.json = JSON.parse(r.body); } catch { r.json = null; }
    return r;
  }
  const ms = (r) => `${r.ms} ms`;
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const basic = (uuid, pw) => ({ Authorization: 'Basic ' + b64(`${uuid}:${pw}`) });

  function instanceOrigin(raw) {
    let s = String(raw || '').trim();
    if (!s) throw new Error('enter your AIOStreams server address');
    if (/^stremio:\/\//i.test(s)) s = 'https://' + s.slice(10);
    if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { throw new Error('that does not look like a URL'); }
    if (!u.host) throw new Error('that does not look like a URL');
    return (u.protocol === 'http:' ? 'http://' : 'https://') + u.host;
  }

  // ---------------------------------------------------------------- settings
  const KEYS = ['torboxKey', 'aioInstance', 'aioUuid', 'aioPassword', 'aioManifestUrl', 'aioMode'];
  async function cfg() {
    const vals = await Promise.all(KEYS.map((k) => Native.get(k)));
    return Object.fromEntries(KEYS.map((k, i) => [k, vals[i] || '']));
  }
  async function save(obj) { for (const [k, v] of Object.entries(obj)) await Native.set(k, v); }

  async function accounts() {
    const c = await cfg();
    const mode = c.aioManifestUrl ? (c.aioMode || 'manifest') : '';
    return {
      torbox: !!c.torboxKey,
      aioMode: mode,
      aioInstance: c.aioInstance,
      aioUuid: c.aioUuid ? c.aioUuid.slice(0, 8) + '…' : '',
      addonsAvailable: mode === 'login' && !!c.aioPassword,
    };
  }

  // ---------------------------------------------------------------- TorBox status page (Better Stack)
  async function fetchStatusPage() {
    const sp = { ok: false, error: '', overall: '', announcement: '', groups: [], reports: [], pageUrl: TORBOX_STATUS, cdnStatus: {} };
    const r = await get(TORBOX_STATUS + '/index.json');
    if (!r.ok || !r.json?.data) { sp.error = `could not read the TorBox status page (${r.why})`; return sp; }
    sp.ok = true;
    sp.overall = r.json.data.attributes?.aggregate_state || '';
    sp.announcement = (r.json.data.attributes?.announcement || '').trim();
    const inc = r.json.included || [];
    const sections = {}, resName = {}, updates = {};
    const resources = [];
    for (const x of inc) {
      const a = x.attributes || {};
      if (x.type === 'status_page_section') sections[x.id] = { name: a.name, pos: a.position };
      else if (x.type === 'status_page_resource') {
        resName[x.id] = a.public_name;
        resources.push({ section: String(a.status_page_section_id), pos: a.position, name: a.public_name, status: a.status });
        if (/ CDN$/.test(a.public_name)) sp.cdnStatus[a.public_name.replace(/ CDN$/, '').toLowerCase()] = a.status;
      } else if (x.type === 'status_update') updates[x.id] = { message: (a.message || '').trim(), at: a.published_at };
    }
    resources.sort((a, b) => a.pos - b.pos);
    for (const [id, s] of Object.entries(sections).sort((a, b) => a[1].pos - b[1].pos)) {
      const comps = resources.filter((r) => r.section === id).map(({ name, status }) => ({ name, status }));
      if (comps.length) sp.groups.push({ name: s.name, components: comps });
    }
    const now = Date.now();
    for (const x of inc.filter((i) => i.type === 'status_report')) {
      const a = x.attributes || {};
      const start = Date.parse(a.starts_at), end = a.ends_at ? Date.parse(a.ends_at) : NaN;
      const kind = a.report_type === 'maintenance' ? 'maintenance' : 'incident';
      let phase;
      if (a.aggregate_state !== 'resolved' && start <= now) phase = 'active';
      else if (a.aggregate_state !== 'resolved') phase = 'upcoming';
      else if (now - (isNaN(end) ? start : end) <= 7 * 864e5) phase = 'recent';
      else continue;
      sp.reports.push({
        id: x.id, title: (a.title || '').trim(), kind, phase, startsAt: a.starts_at, endsAt: a.ends_at || '',
        url: `${TORBOX_STATUS}/${kind === 'maintenance' ? 'maintenance' : 'incident'}/${x.id}`,
        affected: (a.affected_resources || []).map((r) => resName[r.status_page_resource_id]).filter(Boolean),
        updates: (x.relationships?.status_updates?.data || []).map((d) => updates[d.id]).filter((u) => u?.message)
          .sort((p, q) => (p.at < q.at ? 1 : -1)),
      });
    }
    const rank = { active: 0, upcoming: 1, recent: 2 };
    sp.reports.sort((p, q) => rank[p.phase] - rank[q.phase] || (p.startsAt < q.startsAt ? 1 : -1));
    return sp;
  }

  function statusItems(sp) {
    if (!sp.ok) return [{ level: 'warn', label: 'Official status page', detail: sp.error }];
    const out = [];
    const all = sp.groups.flatMap((g) => g.components);
    const bad = all.filter((c) => c.status !== 'operational');
    if (!bad.length) out.push({ level: 'ok', label: 'Official status page', detail: `all ${all.length} components operational` });
    else out.push({
      level: bad.some((c) => c.status === 'downtime') ? 'down' : 'warn', label: 'Official status page',
      detail: `${bad.length} of ${all.length} components affected`, notes: bad.map((c) => `${c.name}: ${c.status}`), blame: 'torbox',
    });
    for (const r of sp.reports) {
      if (r.phase === 'recent') continue;
      const upcoming = r.phase === 'upcoming';
      out.push({
        level: upcoming ? 'info' : r.kind === 'incident' ? 'down' : 'warn',
        label: upcoming ? 'Planned maintenance' : r.kind === 'incident' ? 'Incident now' : 'Maintenance now',
        detail: r.title, blame: upcoming ? '' : 'torbox',
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- TorBox account
  const PLANS = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };
  async function torboxAccountRaw(key) {
    const r = await get(TORBOX_API + '/v1/api/user/me', { headers: { Authorization: 'Bearer ' + key } });
    if (r.status === 401 || r.status === 403) return { status: r.status, error: 'TorBox rejected this API key' };
    const d = r.json?.data;
    if (!r.ok || !d) return { status: r.status, error: r.json?.detail || r.why };
    const exp = Date.parse(d.premium_expires_at);
    return {
      status: 200, error: '',
      info: {
        email: d.email, plan: PLANS[d.plan] ?? `Plan ${d.plan}`, expires: d.premium_expires_at || '',
        daysLeft: isNaN(exp) ? -1 : Math.floor((exp - Date.now()) / 864e5),
        created: d.created_at, downloaded: d.total_bytes_downloaded || 0,
      },
    };
  }

  async function torboxItems(key) {
    const out = [];
    const ping = await get(TORBOX_API + '/', { timeoutMs: 12000 });
    if (ping.ok && ping.json?.success) out.push({ level: 'ok', label: 'TorBox API', detail: 'answering · ' + ms(ping) });
    else out.push({ level: 'down', label: 'TorBox API', detail: ping.why, blame: 'torbox' });
    if (!key) return [...out, { level: 'skip', label: 'Your account', detail: 'not signed in' }];
    const a = await torboxAccountRaw(key);
    if (a.status === 401 || a.status === 403) out.push({ level: 'down', label: 'Your account', detail: 'API key rejected — it may have been reset', blame: 'account' });
    else if (a.error) out.push({ level: 'warn', label: 'Your account', detail: 'could not check: ' + a.error, blame: ping.ok ? '' : 'torbox' });
    else if (a.info.plan === 'Free' || (a.info.expires && a.info.daysLeft < 0)) {
      out.push({ level: 'down', label: 'Your account', detail: a.info.expires ? 'subscription expired' : 'no active subscription', blame: 'account' });
    } else {
      const d = a.info.daysLeft >= 0 ? ` · ${a.info.daysLeft} days left` : '';
      out.push({ level: a.info.daysLeft >= 0 && a.info.daysLeft < 3 ? 'warn' : 'ok', label: 'Your account', detail: a.info.plan + ' plan' + d });
    }
    return out;
  }

  // ---------------------------------------------------------------- CDNs
  const REGION = {
    weur: 'Western Europe', neur: 'Northern Europe', ceur: 'Central Europe', nord: 'Nordics', seur: 'Southern Europe',
    hare: 'Global (Bunny)', erth: 'Global (Cloudflare)', enam: 'East North America', ecan: 'East Canada',
    cnam: 'Central North America', snam: 'South North America', wnam: 'West North America', latm: 'Latin America',
    indi: 'India', apac: 'Asia-Pacific', japn: 'Japan', soce: 'Oceania', meas: 'Middle East', zafr: 'South Africa',
  };
  let cdnRows = new Map();

  async function cdnList(pageStatus) {
    const r = await get(TORBOX_API + '/v1/api/speedtest');
    const rows = [];
    const seen = new Set();
    for (const d of r.json?.data || []) {
      const code = String(d.region).toLowerCase();
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({
        region: code, code: code.toUpperCase(), name: REGION[code] || code.toUpperCase(),
        host: String(d.domain).replace(/^https?:\/\//, ''), testUrl: d.url, closest: !!d.closest,
        pageStatus: pageStatus[code] || '', testable: true, pingMs: -1, avgMs: 0, lost: 0, httpMs: 0, httpCode: 0, level: '', detail: '',
      });
    }
    for (const [code, st] of Object.entries(pageStatus)) {
      if (!seen.has(code)) rows.push({ region: code, code: code.toUpperCase(), name: REGION[code] || code.toUpperCase(), host: '', testUrl: '', closest: false, pageStatus: st, testable: false, pingMs: -1, level: '', detail: '' });
    }
    rows.sort((a, b) => (b.closest - a.closest) || (b.testable - a.testable));
    cdnRows = new Map(rows.map((x) => [x.region, x]));
    return rows;
  }

  const pageLevel = (st, dflt) => ({ operational: 'ok', downtime: 'down', degraded: 'warn', maintenance: 'warn' }[st] || dflt);

  async function probeCDN(row) {
    if (!row.testable) {
      row.level = pageLevel(row.pageStatus, 'info');
      row.detail = 'TorBox publishes no test server for this region — status page only';
      return row;
    }
    let best = -1, sum = 0, okN = 0, lost = 0;
    for (let i = 0; i < 4; i++) {
      const p = await Native.ping(row.host, 443, 3000);
      if (p.ms < 0) { lost++; continue; }
      sum += p.ms; okN++;
      if (best < 0 || p.ms < best) best = p.ms;
    }
    row.pingMs = best; row.avgMs = okN ? Math.round(sum / okN) : 0; row.lost = lost;
    const h = await get(row.testUrl, { headers: { Range: 'bytes=0-0' }, timeoutMs: 8000 });
    row.httpCode = h.status; row.httpMs = h.ms;
    const httpOK = !h.error && (h.status === 200 || h.status === 206);
    if (!okN && !httpOK) [row.level, row.detail] = ['down', 'unreachable — every connection attempt failed'];
    else if (!httpOK) [row.level, row.detail] = ['down', `connects, but will not serve files (${h.why})`];
    else if (lost) [row.level, row.detail] = ['warn', `${lost} of 4 connection attempts failed`];
    else [row.level, row.detail] = ['ok', 'serving files'];
    if (row.pageStatus && row.pageStatus !== 'operational') {
      row.detail += ' · status page says ' + row.pageStatus;
      if (row.level === 'ok') row.level = 'warn';
    }
    return row;
  }

  async function probeAll(rows, onRow) {
    const queue = [...rows];
    const worker = async () => { while (queue.length) { const r = queue.shift(); await probeCDN(r); onRow?.(r); } };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  function cdnSummary(rows) {
    const out = [];
    const closest = rows.find((r) => r.closest);
    const tested = rows.filter((r) => r.testable).length;
    const pageOnly = rows.length - tested;
    if (closest) {
      const it = { level: closest.level, label: 'Your closest CDN', detail: `${closest.code} (${closest.name})${closest.pingMs >= 0 ? ` · ${closest.pingMs} ms` : ''}` };
      if (closest.level === 'down') Object.assign(it, { blame: 'cdn-closest', notes: [closest.detail] });
      out.push(it);
    }
    const down = rows.filter((r) => r.level === 'down').map((r) => r.code);
    const warn = rows.filter((r) => r.level === 'warn').map((r) => r.code);
    if (down.length) out.push({ level: 'warn', label: 'Other CDNs', detail: 'not reachable: ' + down.join(', '), blame: 'cdn-other' });
    else if (warn.length) out.push({ level: 'warn', label: 'Other CDNs', detail: 'flaky: ' + warn.join(', ') });
    else out.push({ level: 'ok', label: 'All CDNs', detail: `${tested} test servers serving files${pageOnly ? ` · ${pageOnly} more regions OK on the status page` : ''}` });
    return out;
  }

  async function probeCDNs(sp, cb) {
    const rows = await cdnList(sp.cdnStatus || {});
    cb.cdnList?.(rows.map((r) => ({ ...r })));
    if (!rows.length) return [{ level: 'warn', label: 'CDN list', detail: 'TorBox did not return its server list' }];
    await probeAll(rows, (r) => cb.cdn?.({ ...r }));
    return cdnSummary(rows);
  }

  async function speedTest(region, onProgress) {
    const row = cdnRows.get(region);
    if (!row?.testUrl) return { mbps: 0, error: 'no test server for this region' };
    return Native.speed(region, row.testUrl, 8, onProgress);
  }

  // ---------------------------------------------------------------- AIOStreams
  const ZW = /[​-‏⁠﻿]/g;
  const ERR_WORDS = /error|failed|❌|invalid|unavailable|maintenance|rate.?limit|timed? ?out|unauthori/i;
  function cleanLine(s) {
    const out = String(s || '').replace(ZW, '').split('\n').map((l) => l.replace(/[ \t  - 　]+/g, ' ').trim()).filter(Boolean).join(' · ');
    return out.length > 140 ? out.slice(0, 140) + '…' : out;
  }

  function parseTitle(input) {
    const s = String(input || '').trim();
    const m = s.match(/tt\d{5,10}/);
    if (!m) throw new Error('enter an IMDb id like tt0111161 (add season and episode for a show, e.g. tt0903747 1 1)');
    const rest = /imdb\.com/.test(s) ? [] : (s.slice(s.indexOf(m[0]) + m[0].length).match(/\d+/g) || []);
    return rest.length >= 2 ? { type: 'series', id: `${m[0]}:${rest[0]}:${rest[1]}` } : { type: 'movie', id: m[0] };
  }

  async function aioLogin(instance, uuid, password) {
    const origin = instanceOrigin(instance);
    uuid = String(uuid || '').trim();
    if (!uuid || !password) throw new Error('enter both your UUID and password');
    const r = await get(origin + '/api/v1/user', { headers: basic(uuid, password), timeoutMs: 20000 });
    if (r.error) throw new Error(`could not reach ${origin}: ${r.error}`);
    const enc = r.json?.data?.encryptedPassword;
    if (!r.json?.success || !enc) {
      let msg = r.json?.error?.message || r.why;
      if ([401, 403, 404].includes(r.status) || /INVALID/.test(r.json?.error?.code || '')) msg = `wrong UUID or password (${msg})`;
      if (r.status === 404 && !r.json) msg = 'this does not look like an AIOStreams server (HTTP 404)';
      throw new Error(msg);
    }
    return { origin, manifest: `${origin}/stremio/${encodeURIComponent(uuid)}/${encodeURIComponent(enc)}/manifest.json` };
  }

  const manifestBase = (m) => m.replace(/manifest\.json(\?.*)?$/i, '').replace(/\/?$/, '/');

  // Stremio stream endpoint — exactly what Nuvio calls. No per-addon detail.
  async function streamEndpointTest(manifest, type, id) {
    const res = { mode: 'manifest', query: id, type, ok: false, error: '', count: 0, instant: 0, secs: 0, errors: [], top: [], addons: [] };
    const r = await get(`${manifestBase(manifest)}stream/${type}/${encodeURIComponent(id)}.json`, { timeoutMs: 60000 });
    res.secs = r.ms / 1000;
    const streams = r.json?.streams;
    if (!r.ok || !Array.isArray(streams)) { res.error = `no answer (${r.why})`; return res; }
    res.ok = true;
    for (const s of streams) {
      const kind = s.streamData?.type || '';
      const playable = !!(s.url || s.infoHash);
      if (kind === 'statistic') continue;
      if (kind === 'error' || (!playable && ERR_WORDS.test(`${s.name} ${s.title} ${s.description}`))) {
        res.errors.push({ addon: '', text: cleanLine(s.description || s.title || s.name) });
        continue;
      }
      if (!playable) continue;
      res.count++;
      if (/⚡/.test(`${s.name}${s.description}`)) res.instant++;
      if (res.top.length < 4) res.top.push(cleanLine(s.name) + '  —  ' + cleanLine(String(s.description || '').replace(ZW, '').trim().split('\n')[0]));
    }
    return res;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const sameAddon = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

  // ---- addon inventory -------------------------------------------------
  // Which addons are enabled, what each one provides (streams / subtitles /
  // metadata), and whether it is anime-only, live TV, or your TorBox library.
  const ANIME_TYPES = new Set(['seadex', 'neko-bt', 'anime-tosho-new', 'animetosho', 'tsukihime', 'nyaa', 'anime-kitsu', 'animekitsu']);
  const ANIME_TITLE = { type: 'series', id: 'tt22248376:1:1', name: 'Frieren S1E1' };
  let presetMeta = null;               // preset ID -> { name, resources, description }
  const manifestResources = new Map(); // custom addon manifest URL -> resources

  function setPresetMeta(statusJson) {
    const list = statusJson?.data?.settings?.presets;
    if (Array.isArray(list)) presetMeta = Object.fromEntries(list.map((p) => [p.ID, { name: p.NAME, resources: p.SUPPORTED_RESOURCES || [], description: p.DESCRIPTION || '' }]));
  }

  async function loadAddons(c) {
    const [user, status] = await Promise.all([
      get(`${c.aioInstance}/api/v1/user`, { headers: basic(c.aioUuid, c.aioPassword), timeoutMs: 20000 }),
      presetMeta ? null : get(`${c.aioInstance}/api/v1/status`),
    ]);
    if (status) setPresetMeta(status.json);
    const userData = user.json?.data?.userData;
    if (!Array.isArray(userData?.presets)) return { list: [], userData: null, error: `could not load your addon list (${user.json?.error?.message || user.why})` };
    const list = await Promise.all(userData.presets.filter((p) => p.enabled !== false).map(async (p) => {
      const meta = presetMeta?.[p.type] || {};
      const name = p.options?.name || meta.name || p.type;
      let res = p.options?.resources?.length ? p.options.resources : meta.resources;
      const url = p.options?.manifestUrl;
      if ((!res || !res.length) && url) {
        if (!manifestResources.has(url)) {
          const m = await get(url, { timeoutMs: 8000 });
          manifestResources.set(url, (m.json?.resources || []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean));
        }
        res = manifestResources.get(url);
      }
      res = res || [];
      const kind = !res.length || res.includes('stream') ? 'stream' : res.includes('subtitles') ? 'subtitles' : 'metadata';
      const anime = ANIME_TYPES.has(p.type) || /anime/i.test(meta.description || '') || /anime|seadex|nyaa|tosho|neko/i.test(name);
      const special = p.type === 'library' ? 'library' : (/\b(live|sports?|iptv)\b/i.test(name) || /-tv$/.test(p.type)) ? 'live' : '';
      return { id: p.instanceId, name, type: p.type, kind, anime, special };
    }));
    return { list, userData, error: '' };
  }

  // A temporary, trimmed copy of the user's config for one search only:
  // duplicate removal, filters and display settings off, stream addons only.
  // Sent only to the user's own AIOStreams server; nothing is saved anywhere.
  const DROP_KEYS = /^(formatter|catalogModifications|variants|healthChecks|appliedTemplates|addonName|addonDescription|addonLogo|addonBackground|selOverrides|regexOverrides|ranked\w*|preferred\w*|excluded\w*|included\w*|required\w*|exclude\w*|include\w*|require\w*|resultLimits|size|bitrate|digitalReleaseFilter|groups|dynamicAddonFetching|statistics|posterService|customPosterUrl|usePoster\w*|rpdbApiKey|topPosterApiKey|aioratings\w*|openposterdb\w*|synced\w*|precache\w*|seederRangeTypes|ageRangeTypes|autoPlay|preloadStreams|cacheAndPlay)$/;
  function rawConfig(userData, streamIds) {
    const u = {};
    for (const [k, v] of Object.entries(userData)) if (!DROP_KEYS.test(k)) u[k] = v;
    u.presets = userData.presets.filter((p) => streamIds.has(p.instanceId));
    u.deduplicator = { enabled: false };
    u.formatter = { id: 'gdrive' }; // required field; the user's own formatter is ~50 KB and only changes how names look
    return u;
  }

  async function rawSearch(c, addons, type, id) {
    const streamIds = new Set(addons.list.filter((a) => a.kind === 'stream').map((a) => a.id));
    const cfgCopy = rawConfig(addons.userData, streamIds);
    const q = `type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
    const r = await get(`${c.aioInstance}/api/v1/search?${q}`, { headers: { 'X-AIOStreams-User-Data': b64(JSON.stringify(cfgCopy)) }, timeoutMs: 60000 });
    const d = r.json?.data;
    if (!r.ok || !d || !Array.isArray(d.results)) return { ok: false, error: r.json?.error?.message || r.why, results: [], errors: [], secs: r.ms / 1000 };
    return { ok: true, error: '', results: d.results.filter((x) => x.type !== 'statistic' && x.type !== 'error'), errors: d.errors || [], secs: r.ms / 1000 };
  }

  // Signed in with UUID + password: the normal search shows what Nuvio gets;
  // the raw search shows what each addon really found.
  async function searchApiTest(c, type, id, opts = {}) {
    const res = { mode: 'login', query: id, type, ok: false, error: '', count: 0, instant: 0, secs: 0, errors: [], top: [], addons: [], statistics: [], rawOk: false, rawError: '', animeQuery: '' };
    const q = `type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
    const [r, addons] = await Promise.all([
      get(`${c.aioInstance}/api/v1/search?${q}`, { headers: basic(c.aioUuid, c.aioPassword), timeoutMs: 60000 }),
      loadAddons(c),
    ]);
    res.secs = r.ms / 1000;
    const d = r.json?.data;
    if (!r.ok || !d || !Array.isArray(d.results)) {
      res.error = r.json?.error?.message ? `${r.json.error.message} (${r.why})` : `no answer (${r.why})`;
      if (r.status === 401 || r.status === 403) res.error = 'AIOStreams rejected your UUID/password — sign in again';
      return res;
    }
    res.ok = true;

    const rows = addons.list.map((a) => ({ ...a, found: 0, foundCached: 0, shown: 0, cached: 0, animeFound: null, errors: [] }));
    const rowFor = (name) => {
      let row = rows.find((x) => sameAddon(x.name, name));
      if (!row) { row = { name: name || 'Unknown addon', type: '', kind: 'stream', anime: false, special: '', found: 0, foundCached: 0, shown: 0, cached: 0, animeFound: null, errors: [] }; rows.push(row); }
      return row;
    };
    const addError = (e, list) => {
      const text = cleanLine(`${e.title || ''}: ${e.description || ''}`.replace(/^: /, ''));
      const match = rows.find((x) => sameAddon(x.name, e.title) || (x.name && norm((e.title || '') + (e.description || '')).includes(norm(x.name))));
      const msg = cleanLine(e.description || e.title);
      if (match && !match.errors.includes(msg)) match.errors.push(msg);
      if (list) list.push({ addon: match?.name || '', text });
    };

    for (const s of d.results) {
      if (s.type === 'statistic' || s.type === 'error') continue;
      res.count++;
      if (s.cached) res.instant++;
      const row = rowFor(s.addon);
      row.shown++;
      if (s.cached) row.cached++;
      if (res.top.length < 4) {
        const reso = s.parsedFile?.resolution ? `${s.parsedFile.resolution} · ` : '';
        res.top.push(`${reso}${cleanLine(s.filename || s.folderName || s.message || 'stream')}${s.addon ? '  —  ' + s.addon : ''}${s.cached ? '  ⚡' : ''}`);
      }
    }
    for (const e of d.errors || []) addError(e, res.errors);
    res.statistics = (d.statistics || []).map((s) => cleanLine(`${s.title}: ${s.description}`));

    // Raw search: what each stream addon found before duplicates and filters.
    if (addons.userData && addons.list.some((a) => a.kind === 'stream')) {
      const raw = await rawSearch(c, addons, type, id);
      res.rawOk = raw.ok; res.rawError = raw.error;
      for (const s of raw.results) { const row = rowFor(s.addon); row.found++; if (s.cached) row.foundCached++; }
      for (const e of raw.errors) addError(e, null);
      if (opts.anime && addons.list.some((a) => a.kind === 'stream' && a.anime)) {
        const an = await rawSearch(c, addons, ANIME_TITLE.type, ANIME_TITLE.id);
        res.animeQuery = ANIME_TITLE.name;
        if (an.ok) {
          for (const row of rows) if (row.kind === 'stream') row.animeFound = 0;
          for (const s of an.results) rowFor(s.addon).animeFound++;
        } else res.animeError = an.error;
      }
    }

    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    res.addons = rows.map((x) => {
      const found = res.rawOk ? x.found : x.shown;
      let level, detail;
      if (x.kind !== 'stream') {
        level = 'skip';
        detail = x.kind === 'subtitles' ? 'Subtitles addon — not a stream source, nothing to test' : 'Metadata / catalog addon — not a stream source, nothing to test';
      } else if (x.errors.length && !found && x.animeFound > 0) {
        level = 'warn'; // failed on the movie, but answered the anime test: up, just slow or flaky
        detail = `${x.errors[0]} on the movie test — but it found ${plural(x.animeFound, 'stream')} in the anime test, so it is up (slow or flaky)`;
      } else if (x.errors.length) {
        level = found ? 'warn' : 'down';
        detail = x.errors[0];
      } else if (found) {
        level = 'ok';
        detail = res.rawOk
          ? `found ${plural(found, 'stream')}${x.foundCached ? ` (${x.foundCached} instant ⚡)` : ''} · ${x.shown ? `${x.shown} shown in Nuvio` : 'all hidden as duplicates or by your filters'}`
          : `${plural(found, 'stream')}${x.cached ? ` · ${x.cached} instant ⚡` : ''}`;
      } else if (x.anime) {
        if (x.animeFound > 0) { level = 'ok'; detail = `anime only — found ${plural(x.animeFound, 'stream')} in the anime test (${ANIME_TITLE.name})`; }
        else if (x.animeFound === 0) { level = 'warn'; detail = `anime only — found nothing in the anime test (${ANIME_TITLE.name}) either`; }
        else { level = 'info'; detail = 'anime only — nothing for a movie is normal (turn on the anime test to check it)'; }
      } else if (x.special === 'library') {
        level = 'info'; detail = 'only lists what is already in your TorBox cloud — empty is normal';
      } else if (x.special === 'live') {
        level = 'info'; detail = 'live TV / sports addon — not used for movies';
      } else {
        level = 'warn'; detail = 'found nothing for this title — it may be down, blocked or slow';
      }
      return { ...x, found, level, detail };
    });
    if (addons.error) res.addonsNote = addons.error;
    return res;
  }

  async function aioCheck(c) {
    const manifest = c.aioManifestUrl;
    if (!manifest) return { items: [{ level: 'skip', label: 'AIOStreams', detail: 'not signed in', blame: 'aio-skip' }], addons: null };
    const origin = c.aioInstance || instanceOrigin(manifest);
    const host = origin.replace(/^https?:\/\//, '');
    const login = c.aioMode === 'login' && c.aioPassword && c.aioUuid;
    const items = [];
    const status = await get(origin + '/api/v1/status');
    if (status.ok && status.json?.data?.version) items.push({ level: 'ok', label: 'Server', detail: `${host} · v${status.json.data.version} · ${ms(status)}` });
    else if (!status.status) return { items: [{ level: 'down', label: 'Server', detail: `${host} — ${status.why}`, blame: 'aio' }], addons: null };
    else items.push({ level: 'warn', label: 'Server', detail: `${host} — status ${status.why}` });
    setPresetMeta(status.json);

    let sr;
    if (login) {
      sr = await searchApiTest({ ...c, aioInstance: origin }, TEST_TITLE.type, TEST_TITLE.id, { anime: (await Native.get('animeTest')) === '1' });
      if (!sr.ok && /disabled|not enabled|403/i.test(sr.error)) sr = null; // search API turned off on this server
    }
    if (!sr) {
      const man = await get(manifest, { timeoutMs: 20000 });
      if (!man.ok || !man.json?.id) return { items: [...items, { level: 'down', label: 'Your config', detail: `does not load (${man.why}) — sign in again`, blame: 'aio' }], addons: null };
      items.push({ level: 'ok', label: 'Your config', detail: `"${man.json.name}" loads · ${login ? 'signed in' : 'manifest URL'}` });
      sr = await streamEndpointTest(manifest, TEST_TITLE.type, TEST_TITLE.id);
    } else if (sr.ok) {
      items.push({ level: 'ok', label: 'Your config', detail: 'signed in · search API' });
    }

    const label = `Test search (${TEST_TITLE.name})`;
    if (!sr.ok) items.push({ level: 'down', label, detail: sr.error, blame: 'aio' });
    else if (!sr.count) {
      items.push({
        level: 'down', label, detail: `0 playable streams (${sr.secs.toFixed(1)} s)`,
        notes: sr.errors.length ? sr.errors.slice(0, 4).map((e) => e.text) : ['AIOStreams answered but found nothing — usually TorBox search or the scrapers behind it'],
        blame: sr.errors.length ? 'aio-error' : 'aio-empty',
      });
    } else {
      items.push({
        level: sr.errors.length ? 'warn' : 'ok', label,
        detail: `${sr.count} streams in ${sr.secs.toFixed(1)} s${sr.instant ? ` · ${sr.instant} instant ⚡` : ''}`,
        notes: sr.errors.slice(0, 4).map((e) => 'addon says: ' + e.text), blame: sr.errors.length ? 'aio-partial' : '',
      });
    }
    if (sr.secs > 20) items.push({ level: 'warn', label: 'Speed', detail: `very slow (${sr.secs.toFixed(1)} s) — Nuvio may give up before results arrive` });
    return { items, addons: sr };
  }

  function addonItems(sr, c) {
    if (!c.aioManifestUrl) return [{ level: 'skip', label: 'Addons', detail: 'sign in to AIOStreams first' }];
    if (!sr || sr.mode !== 'login') return [{ level: 'skip', label: 'Addons', detail: 'sign in with UUID + password to check each addon', blame: '' }];
    if (!sr.ok) return [{ level: 'down', label: 'Addons', detail: sr.error }];
    const rows = sr.addons;
    if (!rows.length) return [{ level: 'info', label: 'Addons', detail: sr.addonsNote || 'no enabled addons found' }];
    const streams = rows.filter((r) => r.kind === 'stream');
    const failing = streams.filter((r) => r.level === 'down').map((r) => r.name);
    const empty = streams.filter((r) => r.level === 'warn' && !r.errors.length).map((r) => r.name);
    const erroring = streams.filter((r) => r.level === 'warn' && r.errors.length).map((r) => r.name);
    const working = streams.filter((r) => r.level === 'ok').length;
    const others = rows.length - streams.length;
    const out = [{
      level: failing.length || empty.length || erroring.length ? 'warn' : 'ok', label: 'Stream addons',
      detail: `${working} of ${streams.length} working${others ? ` · ${others} subtitle/metadata addon${others === 1 ? '' : 's'} skipped` : ''}`,
    }];
    if (failing.length) out.push({ level: 'down', label: 'Failing', detail: failing.join(', '), blame: 'addon-down' });
    if (erroring.length) out.push({ level: 'warn', label: 'With errors', detail: erroring.join(', ') });
    if (empty.length) out.push({ level: 'warn', label: 'Found nothing', detail: empty.join(', ') });
    if (!sr.rawOk && sr.rawError) out.push({ level: 'info', label: 'Raw counts', detail: `unavailable (${sr.rawError}) — showing counts after duplicates` });
    return out;
  }

  async function testTitle(input) {
    const c = await cfg();
    if (!c.aioManifestUrl) throw new Error('sign in to AIOStreams first (Accounts page)');
    const { type, id } = parseTitle(input);
    if (c.aioMode === 'login' && c.aioPassword) {
      const r = await searchApiTest({ ...c, aioInstance: c.aioInstance || instanceOrigin(c.aioManifestUrl) }, type, id);
      if (r.ok || !/disabled|not enabled/i.test(r.error)) return r;
    }
    return streamEndpointTest(c.aioManifestUrl, type, id);
  }

  // ---------------------------------------------------------------- others
  async function internetItems() {
    const [a, b] = await Promise.all([get('https://www.google.com/generate_204', { timeoutMs: 8000 }), get('https://1.1.1.1/cdn-cgi/trace', { timeoutMs: 8000 })]);
    const ok = [a, b].find((r) => !r.error && r.status > 0 && r.status < 400);
    return ok ? [{ level: 'ok', label: 'Your internet', detail: 'connected · ' + ms(ok) }] : [{ level: 'down', label: 'Your internet', detail: a.why, blame: 'internet' }];
  }

  async function nuvioItems() {
    const [tm, cm, site] = await Promise.all([
      get('https://api.themoviedb.org/3/configuration', { timeoutMs: 12000 }),
      get('https://v3-cinemeta.strem.io/manifest.json', { timeoutMs: 12000 }),
      get('https://nuvioapp.space/', { timeoutMs: 12000 }),
    ]);
    const out = [];
    // TMDB answers 401 without a key — that still proves it is up.
    out.push(!tm.error && (tm.status === 200 || tm.status === 401) ? { level: 'ok', label: 'TMDB (metadata)', detail: ms(tm) } : { level: 'warn', label: 'TMDB (metadata)', detail: tm.why, blame: 'meta' });
    out.push(cm.ok ? { level: 'ok', label: 'Cinemeta (catalogs)', detail: ms(cm) } : { level: 'warn', label: 'Cinemeta (catalogs)', detail: cm.why, blame: 'meta' });
    out.push(site.ok ? { level: 'ok', label: 'Nuvio website', detail: ms(site) } : {
      level: 'info', label: 'Nuvio website', detail: `unreachable (${site.why})`,
      notes: ['Nuvio runs on your device — its website being down does not stop playback.'],
    });
    return out;
  }

  function verdict(items) {
    const has = {};
    for (const it of items) if (it.blame && !has[it.blame]) has[it.blame] = it;
    const v = (level, title, message) => ({ level, title, message });
    if (has.internet) return v('down', 'Your internet is down', 'Nothing else can work until your own connection is back.');
    if (has.torbox) {
      const m = items.find((x) => x.label === 'Maintenance now');
      const i = items.find((x) => x.label === 'Incident now');
      if (m) return v('down', 'TorBox is in maintenance: ' + m.detail, 'Nothing to fix on your side — wait for TorBox. Their statement is shown below.');
      if (i) return v('down', 'TorBox incident: ' + i.detail, 'Nothing to fix on your side — wait for TorBox. Their statement is shown below.');
      return v('down', 'TorBox has a problem: ' + has.torbox.detail, has.torbox.label === 'TorBox API' ? 'The TorBox API is not answering. Nothing to fix on your side — wait it out.' : 'Nothing to fix on your side — wait for TorBox.');
    }
    if (has.account) return v('down', 'TorBox account problem', has.account.detail + ' — check torbox.app.');
    if (has['cdn-closest']) return v('down', 'Your closest TorBox CDN is down', has['cdn-closest'].detail + '. Streams served from it will fail; others may still play.');
    if (has.aio) return v('down', 'AIOStreams is the problem', `${has.aio.label}: ${has.aio.detail}`);
    if (has['aio-error']) return v('down', 'AIOStreams returns errors', has['aio-error'].notes?.[0] || 'AIOStreams returned errors instead of streams.');
    if (has['aio-empty']) return v('warn', 'Everything is up, but no streams came back', 'AIOStreams found nothing for the test movie — a scraper or TorBox search may be struggling.');
    if (has['addon-down']) return v('warn', 'Some AIOStreams addons are failing', `${has['addon-down'].detail} — streams still come back from your other addons.`);
    if (has.meta) return v('warn', 'Metadata services are flaky', 'Posters or catalogs may fail to load in Nuvio, but streams should still work.');
    if (has['aio-partial']) return v('warn', 'Mostly working', 'Some AIOStreams sources reported errors, but streams come back.');
    if (has['cdn-other']) return v('warn', 'Working — some far-away CDNs are down', has['cdn-other'].detail + '. Your own region is fine.');
    if (has['aio-skip']) return v('ok', 'Everything checked is up', 'Sign in to AIOStreams on the Accounts page so a real search can be tested too.');
    return v('ok', 'Everything is up', 'Streams come back fine. If one title will not play, try another release of it.');
  }

  // ---------------------------------------------------------------- orchestration
  let running = false;
  async function runChecks(cb) {
    if (running) return null;
    running = true;
    const t0 = performance.now();
    const all = [];
    const emit = (id, items) => { all.push(...items); cb.section?.(id, items); };
    try {
      const c = await cfg();
      const spP = fetchStatusPage();
      await Promise.all([
        internetItems().then((i) => emit('internet', i)),
        spP.then((sp) => { cb.status?.(sp); emit('torbox-status', statusItems(sp)); }),
        torboxItems(c.torboxKey).then((i) => emit('torbox', i)),
        aioCheck(c).then(({ items, addons }) => { emit('aio', items); cb.addons?.(addons); emit('addons', addonItems(addons, c)); }),
        nuvioItems().then((i) => emit('nuvio', i)),
        spP.then((sp) => probeCDNs(sp, cb)).then((i) => emit('cdn', i)),
      ]);
      return { ...verdict(all), at: new Date().toISOString(), secs: (performance.now() - t0) / 1000 };
    } finally { running = false; }
  }

  async function refreshCDNs(cb) {
    if (running) return null;
    running = true;
    try { const items = await probeCDNs(await fetchStatusPage(), cb); cb.section?.('cdn', items); return items; }
    finally { running = false; }
  }

  // ---------------------------------------------------------------- Wi-Fi pairing (phone side)
  // The PC's QR code holds https://…/pair/#<payload> (or streamcheck://pair?d=<payload>).
  // payload = base64url(JSON {v, h:[LAN IPs], p:port, t:pairing id, k:AES-256 key}).
  const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  function parsePair(text) {
    const s = String(text || '').trim();
    const m = s.match(/[#?&]d=([A-Za-z0-9_-]+)/) || s.match(/#([A-Za-z0-9_-]{40,})$/) || s.match(/^([A-Za-z0-9_-]{40,})$/);
    if (!m) throw new Error('This is not a Stream Check pairing code.');
    let p;
    try { p = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1]))); } catch { throw new Error('This pairing code is damaged — show a new one on your PC.'); }
    if (p.v !== 1 || !Array.isArray(p.h) || !p.h.length || !p.p || !p.t || !p.k) throw new Error('This pairing code is from a newer or older Stream Check — update both apps.');
    return p;
  }

  async function pairWithPC(text, onStatus = () => {}) {
    const p = parsePair(text);
    const hosts = p.h.filter((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
    onStatus('connecting');
    const base = await Promise.any(hosts.map(async (h) => {
      const r = await get(`http://${h}:${p.p}/hello?id=${encodeURIComponent(p.t)}`, { timeoutMs: 4000 });
      if (!r.ok || r.json?.app !== 'stream-check') throw new Error('no');
      return `http://${h}:${p.p}`;
    })).catch(() => {
      throw new Error('Could not reach your PC. Make sure your phone is on the same Wi-Fi as the PC, the QR code is less than 2 minutes old, and Windows Firewall allowed Stream Check. Using a VPN on the PC? Allow local network access in its settings.');
    });
    onStatus('waiting');
    const r = await Native.http({ method: 'POST', url: base + '/pair', json: { id: p.t, device: await Native.deviceName() }, timeoutMs: 100000 });
    let body = null;
    try { body = JSON.parse(r.body); } catch {}
    if (r.status === 403) throw new Error(`Not allowed — ${body?.error || 'the PC said no'}.`);
    if (r.status === 410) throw new Error('This QR code was already used — show a new one on your PC.');
    if (r.error || r.status !== 200 || !body?.iv || !body?.ct) throw new Error(`Pairing failed (${r.error || 'HTTP ' + r.status}).`);
    const key = await crypto.subtle.importKey('raw', b64urlToBytes(p.k), 'AES-GCM', false, ['decrypt']);
    let creds;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(body.iv) }, key, b64urlToBytes(body.ct));
      creds = JSON.parse(new TextDecoder().decode(plain));
    } catch { throw new Error('Could not unlock the sign-ins from your PC — show a new QR code and try again.'); }
    const clean = Object.fromEntries(KEYS.map((k) => [k, typeof creds[k] === 'string' ? creds[k] : '']));
    await save(clean);
    onStatus('done');
    return { torbox: !!clean.torboxKey, aio: !!clean.aioManifestUrl, aioMode: clean.aioMode };
  }

  // ---------------------------------------------------------------- account actions
  async function loginTorbox(key) {
    key = String(key || '').trim();
    if (!key) throw new Error('paste your API key first');
    const a = await torboxAccountRaw(key);
    if (a.status === 401 || a.status === 403) throw new Error('TorBox rejected this API key — copy it again from torbox.app → Settings');
    await save({ torboxKey: key });
    return a.error ? `Saved, but TorBox could not confirm it right now (${a.error}).` : '';
  }
  async function torboxAccount() {
    const c = await cfg();
    if (!c.torboxKey) throw new Error('not signed in');
    const a = await torboxAccountRaw(c.torboxKey);
    if (a.error) throw new Error(a.error);
    return a.info;
  }
  async function loginAio(instance, uuid, password) {
    const { origin, manifest } = await aioLogin(instance, uuid, password);
    await save({ aioInstance: origin, aioUuid: String(uuid).trim(), aioPassword: password, aioManifestUrl: manifest, aioMode: 'login' });
  }
  async function loginAioManifest(url) {
    let m = String(url || '').trim();
    if (/^stremio:\/\//i.test(m)) m = 'https://' + m.slice(10);
    const origin = instanceOrigin(m);
    if (!/manifest\.json/i.test(m)) throw new Error('paste the full URL ending in /manifest.json');
    const r = await get(m, { timeoutMs: 20000 });
    if (!r.ok || !r.json?.id) throw new Error(`that manifest does not load (${r.why})`);
    await save({ aioInstance: origin, aioUuid: '', aioPassword: '', aioManifestUrl: m, aioMode: 'manifest' });
  }
  const logoutTorbox = () => save({ torboxKey: '' });
  const logoutAio = () => save({ aioUuid: '', aioPassword: '', aioManifestUrl: '', aioMode: '' });

  return {
    accounts, runChecks, refreshCDNs, speedTest, testTitle,
    loginTorbox, logoutTorbox, torboxAccount, loginAio, loginAioManifest, logoutAio,
    parsePair, pairWithPC,
    getAnimeTest: async () => (await Native.get('animeTest')) === '1',
    setAnimeTest: (on) => Native.set('animeTest', on ? '1' : ''),
    savedInstance: async () => (await cfg()).aioInstance,
  };
})();
