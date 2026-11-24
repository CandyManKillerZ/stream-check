'use strict';
// Stream Check UI — renders what Core (core.js) reports. Everything that came
// from the network goes through esc() before it touches innerHTML.

const VERSION = APP_VERSION;
const REPO_URL = 'https://github.com/CandyManKillerZ/stream-check';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  sections: {},     // id -> items
  status: null,     // TorBox status page
  cdns: new Map(),  // region -> row
  speeds: {},       // region -> {mbps, done, error, running}
  addons: null,     // last search result with per-addon rows
  running: false,
  accounts: null,
  torboxInfo: null,
  aioTab: 'login',
};

const CARDS = [
  { id: 'connection', title: 'Connection', sections: ['internet'] },
  { id: 'torbox', title: 'TorBox', sections: ['torbox-status', 'torbox'], link: ['news', 'Announcements'] },
  { id: 'cdn', title: 'TorBox CDNs', sections: ['cdn'], link: ['cdns', 'All regions'] },
  { id: 'aio', title: 'AIOStreams', sections: ['aio'], link: ['title', 'Test a title'] },
  { id: 'addons', title: 'AIOStreams addons', sections: ['addons'], link: ['addons', 'Each addon'] },
  { id: 'nuvio', title: 'Nuvio services', sections: ['nuvio'] },
];

const ICONS = {
  ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  idle: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
};
const RANK = { down: 3, warn: 2, ok: 1, info: 0, skip: 0 };
const LEVEL_TEXT = { ok: 'Operational', warn: 'Degraded', down: 'Down', info: 'Info', skip: 'Not set up' };

// ---------------------------------------------------------------- helpers
const fmtTime = (iso, withDay = true) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, withDay
    ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const worst = (items) => items.reduce((w, it) => (RANK[it.level] > RANK[w] ? it.level : w), 'ok');
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}
function busy(btn, on) {
  btn.disabled = on;
  btn.querySelector('.spin')?.toggleAttribute('hidden', !on);
}

// ---------------------------------------------------------------- navigation
const TITLES = { overview: 'Overview', news: 'TorBox announcements', cdns: 'TorBox CDNs', addons: 'AIOStreams addons', title: 'Test a title', accounts: 'Accounts', about: 'About' };
// Page order for swiping (same as the sidebar). On phones the last three live
// in the More sheet, but swiping still walks through all of them.
const PAGE_ORDER = ['overview', 'news', 'cdns', 'addons', 'title', 'accounts', 'about'];
const MORE_PAGES = new Set(['title', 'accounts', 'about']);
let currentPage = 'overview';

function showPage(page, dir = 0) {
  if (page === 'more') return openSheet();
  closeSheet();
  const changed = page !== currentPage;
  currentPage = page;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === page || (b.dataset.page === 'more' && MORE_PAGES.has(page))));
  document.querySelectorAll('.page').forEach((p) => {
    p.hidden = p.id !== `page-${page}`;
    p.classList.remove('slide-l', 'slide-r');
  });
  const el = $(`page-${page}`);
  if (changed && dir && el) { void el.offsetWidth; el.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); }
  $('page-title').textContent = TITLES[page];
  document.querySelector('main').scrollTop = 0;
  if (page === 'accounts') renderAccounts(true);
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => {
  const to = b.dataset.page;
  showPage(to, to === 'more' ? 0 : Math.sign(PAGE_ORDER.indexOf(to) - PAGE_ORDER.indexOf(currentPage)));
}));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); showPage(g.dataset.go); }
  const u = e.target.closest('[data-url]');
  if (u) { e.preventDefault(); closeSheet(); Native.open(u.dataset.url); }
});

function openSheet() { $('sheet').hidden = false; requestAnimationFrame(() => $('sheet').classList.add('open')); }
function closeSheet() { $('sheet').classList.remove('open'); $('sheet').hidden = true; }
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

// ---- swipe left / right between pages (phones)
// Swipes that start within 24 px of the screen edge are left to Android's own
// back gesture; swipes inside tables, inputs or popups are ignored.
(function swipeNav() {
  const main = document.querySelector('main');
  let x0 = 0, y0 = 0, t0 = 0, track = false;
  main.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    track = e.touches.length === 1 && t.clientX > 24 && t.clientX < window.innerWidth - 24
      && !e.target.closest('input, textarea, .table-card, .update-notes, .modal, .sheet-wrap');
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
  }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (!track) return;
    track = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - t0 > 700) return;
    const i = PAGE_ORDER.indexOf(currentPage) + (dx < 0 ? 1 : -1);
    if (i < 0 || i >= PAGE_ORDER.length) return;
    showPage(PAGE_ORDER[i], dx < 0 ? 1 : -1);
    Native.vibrate(8);
  }, { passive: true });
})();

// ---- pull down to check (phones)
(function pullToCheck() {
  const main = document.querySelector('main');
  const ptr = $('ptr');
  const TRIGGER = 80;
  let y0 = null, pull = 0, armed = false;
  main.addEventListener('touchstart', (e) => {
    y0 = main.scrollTop <= 0 && !state.running && e.touches.length === 1 && !e.target.closest('.modal, .sheet-wrap') ? e.touches[0].clientY : null;
    pull = 0; armed = false;
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    pull = Math.max(0, e.touches[0].clientY - y0);
    if (main.scrollTop > 0) { pull = 0; }
    const h = Math.min(pull * 0.5, 70);
    ptr.style.height = h + 'px';
    ptr.style.opacity = Math.min(1, h / 40);
    const nowArmed = pull >= TRIGGER;
    if (nowArmed !== armed) { armed = nowArmed; if (armed) Native.vibrate(10); }
    ptr.classList.toggle('armed', armed);
    $('ptr-text').textContent = armed ? 'Release to check everything' : 'Pull to check everything';
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    ptr.style.height = '0px'; ptr.style.opacity = 0; ptr.classList.remove('armed');
    if (armed) { showPage('overview', 0); runCheck(); }
  }, { passive: true });
})();
$('open-status').addEventListener('click', () => Native.open('https://status.torbox.app'));

// ---------------------------------------------------------------- full check
const callbacks = {
  section: (id, items) => { state.sections[id] = items; renderCards(); },
  status: (sp) => { state.status = sp; renderStatus(); },
  cdnList: (rows) => { state.cdns = new Map(rows.map((r) => [r.region, r])); renderCDNTable(); },
  cdn: (r) => { state.cdns.set(r.region, r); updateCDNRow(r.region); },
  addons: (sr) => { state.addons = sr; renderAddons(); },
};

async function runCheck() {
  if (state.running) return;
  state.running = true;
  state.sections = {};
  state.cdns = new Map();
  state.speeds = {};
  busy($('check-btn'), true);
  $('check-btn').querySelector('.lbl').textContent = 'Checking…';
  setVerdict({ level: 'busy', title: 'Checking everything…', message: 'TorBox, every CDN, AIOStreams and its addons, and Nuvio’s services — all at once.' });
  renderCards();
  renderCDNTable();
  try {
    const v = await Core.runChecks(callbacks);
    if (v) {
      setVerdict(v);
      $('last-check').textContent = `Last check ${fmtTime(v.at, false)}`;
      saveSnapshot(v);
      Native.vibrate(v.level === 'ok' ? 20 : [30, 60, 30]);
    }
  } catch (e) {
    setVerdict({ level: 'down', title: 'The check itself failed', message: String(e?.message || e) });
  } finally {
    state.running = false;
    busy($('check-btn'), false);
    $('check-btn').querySelector('.lbl').textContent = 'Check now';
    renderCards();
  }
}
$('check-btn').addEventListener('click', runCheck);

// The last check's results are kept on this device only, so reopening the app
// shows them straight away (with their age) instead of an empty screen.
const SNAP_KEY = 'sc_last_check';
function saveSnapshot(v) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      v, sections: state.sections, status: state.status, cdns: [...state.cdns.values()], addons: state.addons,
    }));
  } catch {}
}
function clearSnapshot() { try { localStorage.removeItem(SNAP_KEY); } catch {} }
function restoreSnapshot() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch {}
  if (!s?.v) return;
  state.sections = s.sections || {};
  state.status = s.status || null;
  state.cdns = new Map((s.cdns || []).map((r) => [r.region, r]));
  state.addons = s.addons || null;
  setVerdict({ ...s.v, message: `${s.v.message} — result from ${ago(s.v.at)}; press Check now for a fresh one.` });
  $('last-check').textContent = `Last check ${fmtTime(s.v.at)}`;
  renderCards(); renderStatus(); renderCDNTable(); renderAddons();
}

function setVerdict(v) {
  const lv = v.level || 'idle';
  $('verdict').className = `verdict lv-${lv}`;
  $('v-icon').innerHTML = lv === 'busy' ? '<span class="spin big"></span>' : (ICONS[lv] || ICONS.idle);
  $('v-title').textContent = v.title;
  $('v-msg').textContent = v.message;
  $('v-meta').innerHTML = v.at ? `${esc(fmtTime(v.at))}<br>took ${v.secs.toFixed(1)} s` : '';
}

// ---------------------------------------------------------------- overview cards
function renderCards() {
  $('cards').innerHTML = CARDS.map((card) => {
    const parts = card.sections.map((s) => state.sections[s]);
    const done = parts.filter(Boolean);
    const items = done.flat();
    const pending = parts.length - done.length;
    const lv = items.length ? worst(items) : 'idle';
    const allSkip = items.length && items.every((i) => i.level === 'skip');
    const pill = !items.length
      ? (state.running ? '<span class="pill">checking…</span>' : '<span class="pill">not checked</span>')
      : `<span class="pill lv-${allSkip ? 'skip' : lv}">${allSkip ? 'Not set up' : LEVEL_TEXT[lv]}</span>`;
    const rows = items.map(itemHTML).join('');
    const skel = pending && state.running ? '<div class="skel" style="width:70%"></div><div class="skel" style="width:45%"></div>' : '';
    const empty = !items.length && !state.running ? '<div class="muted small" style="padding:10px 0">Press Check now.</div>' : '';
    const link = card.link ? `<a class="link" data-go="${card.link[0]}">${card.link[1]} →</a>` : '';
    return `<div class="card">
      <div class="svc-head"><div class="card-title">${card.title} ${pill}</div>${link}</div>
      <div class="svc-body">${rows}${skel}${empty}</div>
    </div>`;
  }).join('');
}

function itemHTML(it) {
  const notes = it.notes?.length ? `<div class="notes">${it.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : '';
  let detail = esc(it.detail);
  if (it.level === 'skip') detail += ` · <a class="link" data-go="accounts">sign in</a>`;
  return `<div class="it lv-${it.level}"><span class="dot"></span><span class="lb">${esc(it.label)}</span><span class="dt">${detail}</span>${notes}</div>`;
}

// ---------------------------------------------------------------- announcements
function renderStatus() {
  const sp = state.status;
  const reports = sp?.reports || [];
  const live = reports.filter((r) => r.phase !== 'recent');
  const badge = $('news-badge');
  badge.hidden = !live.length;
  badge.textContent = live.length;
  badge.classList.toggle('red', live.some((r) => r.phase === 'active'));

  const banner = sp?.announcement ? `<div class="banner"><b>TorBox announcement</b><br>${esc(sp.announcement)}</div>` : '';
  const ov = $('ov-statements');
  if (!sp) ov.innerHTML = '';
  else if (!sp.ok) ov.innerHTML = `<div class="quiet"><span class="dot lv-warn"></span>${esc(sp.error)}</div>`;
  else if (live.length) ov.innerHTML = banner + live.map((r) => stmtHTML(r, false)).join('');
  else {
    const last = reports[0];
    ov.innerHTML = banner + `<div class="quiet"><span class="dot lv-ok"></span>
      <span>No maintenance or incidents announced by TorBox right now.</span>
      ${last ? `<span class="muted small quiet-last">Last statement: “${esc(last.title)}”, ${esc(ago(last.updates[0]?.at || last.startsAt))} · <a class="link" data-go="news">read</a></span>` : ''}</div>`;
  }

  $('announce-banner').innerHTML = banner;
  if (!sp) $('news-list').innerHTML = '<div class="quiet">Run a check to load TorBox’s statements.</div>';
  else if (!sp.ok) $('news-list').innerHTML = `<div class="quiet"><span class="dot lv-warn"></span>${esc(sp.error)}</div>`;
  else {
    const groups = [['active', 'Happening now'], ['upcoming', 'Planned'], ['recent', 'Last 7 days']];
    $('news-list').innerHTML = groups.map(([ph, name]) => {
      const rs = reports.filter((r) => r.phase === ph);
      if (!rs.length) return ph === 'active' ? '<div class="quiet"><span class="dot lv-ok"></span>Nothing happening right now — no active maintenance or incidents.</div>' : '';
      return `<h2 class="h2">${name}</h2>` + rs.map((r) => stmtHTML(r, true)).join('');
    }).join('');
  }
  $('components').innerHTML = sp?.ok ? `<div class="comp-grid">${sp.groups.map((g) => `
    <div class="card"><div class="gname">${esc(g.name)}</div>
      ${g.components.map((c) => {
        const lv = c.status === 'operational' ? 'ok' : c.status === 'downtime' ? 'down' : 'warn';
        return `<div class="comp"><span class="dot lv-${lv}"></span>${esc(c.name)}<span class="st">${esc(c.status)}</span></div>`;
      }).join('')}
    </div>`).join('')}</div>` : '';
}

function stmtHTML(r, full) {
  const kindPill = r.kind === 'incident' ? '<span class="pill lv-down">Incident</span>' : '<span class="pill purple">Maintenance</span>';
  const phasePill = { active: `<span class="pill ${r.kind === 'incident' ? 'lv-down' : 'lv-warn'}">Now</span>`, upcoming: '<span class="pill lv-info">Planned</span>', recent: '<span class="pill lv-ok">Resolved</span>' }[r.phase];
  let when;
  if (r.phase === 'upcoming') when = `Starts ${fmtTime(r.startsAt)}${r.endsAt ? ` · planned to end ${fmtTime(r.endsAt)}` : ''}`;
  else if (r.phase === 'active') when = `Since ${fmtTime(r.startsAt)}${r.endsAt ? ` · planned end ${fmtTime(r.endsAt)}` : ''}`;
  else when = `${fmtTime(r.startsAt)}${r.endsAt ? ` → ${fmtTime(r.endsAt)}` : ''}`;
  const ups = r.updates || [];
  const affected = r.affected?.length ? `<div class="stmt-affected">Affects: ${esc(r.affected.join(', '))}</div>` : '';
  const body = full
    ? `<div class="timeline">${ups.map((u) => `<div class="tl"><span class="when">${esc(fmtTime(u.at))}</span>${esc(u.message)}</div>`).join('') || '<div class="muted small">No written statement.</div>'}</div>`
    : (ups[0] ? `<div class="stmt-latest"><span class="when">Latest statement · ${esc(fmtTime(ups[0].at))}</span>${esc(ups[0].message)}</div>` : '');
  const more = !full && ups.length > 1 ? `<a class="link" data-go="news">All ${ups.length} updates</a>` : '';
  return `<div class="stmt ${r.phase} ${r.kind}">
    <div class="stmt-head"><div><div class="stmt-title">${esc(r.title)}</div><div class="stmt-when">${esc(when)}</div></div>
      <div class="pills">${kindPill}${phasePill}</div></div>
    ${body}${affected}
    <div class="stmt-foot">${more}<a class="link" data-url="${esc(r.url)}">Open on status.torbox.app ↗</a></div>
  </div>`;
}

// ---------------------------------------------------------------- CDN table
const msClass = (v, good, mid) => (v < 0 ? 'ms-bad' : v <= good ? 'ms-good' : v <= mid ? 'ms-mid' : 'ms-bad');

function renderCDNTable() {
  const body = $('cdn-body');
  if (!state.cdns.size) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${state.running ? 'Fetching TorBox’s server list…' : 'Run a check to ping every CDN.'}</td></tr>`;
    return;
  }
  body.innerHTML = [...state.cdns.values()].map(cdnRowHTML).join('');
}

function cdnRowHTML(r) {
  const measured = !!r.level;
  const pageLv = r.pageStatus === 'operational' ? 'ok' : r.pageStatus === 'downtime' ? 'down' : r.pageStatus ? 'warn' : 'skip';
  const page = r.pageStatus ? `<span class="pill lv-${pageLv}">${esc(r.pageStatus)}</span>` : '<span class="muted small">not listed</span>';
  const ping = !r.testable ? '—' : !measured ? '<span class="spin dim"></span>'
    : r.pingMs < 0 ? '<span class="ms-bad">no reply</span>'
    : `<span class="${msClass(r.pingMs, 60, 150)}">${r.pingMs} ms</span>${r.lost ? ` <span class="ms-bad small">(${r.lost}/4 lost)</span>` : ''}`;
  const file = !r.testable || !measured ? '—' : r.httpCode ? `<span class="${msClass(r.httpMs, 250, 700)}">${r.httpMs} ms</span>` : '<span class="ms-bad">failed</span>';
  const res = measured ? `<span class="pill lv-${r.level}">${r.level === 'ok' ? 'OK' : LEVEL_TEXT[r.level] || r.level}</span> <span class="res">${esc(r.detail)}</span>` : '';
  const sp = state.speeds[r.region];
  let speed = '—';
  if (r.testable && measured) {
    if (sp?.running) speed = `<span class="val">${sp.mbps ? sp.mbps.toFixed(0) + ' Mbps' : '…'}</span>`;
    else if (sp?.error) speed = `<span class="ms-bad small">${esc(sp.error)}</span> <button class="btn ghost sm" data-speed="${esc(r.region)}">Retry</button>`;
    else if (sp?.done) speed = `<span class="val">${sp.mbps.toFixed(0)} Mbps</span> <button class="btn ghost sm" data-speed="${esc(r.region)}">↻</button>`;
    else speed = `<button class="btn ghost sm" data-speed="${esc(r.region)}">Speed test</button>`;
  }
  return `<tr class="${r.closest ? 'closest' : ''}" id="cdn-${esc(r.region)}">
    <td><span class="code">${esc(r.code)}</span> ${r.closest ? '<span class="pill lv-ok">Closest</span>' : ''}<div class="rname">${esc(r.name)}</div></td>
    <td class="host">${esc(r.host || '—')}</td>
    <td class="pagest">${page}</td>
    <td class="num">${ping}</td>
    <td class="num file">${file}</td>
    <td class="result">${res}</td>
    <td class="num speed">${speed}</td>
  </tr>`;
}

function updateCDNRow(region) {
  const r = state.cdns.get(region);
  const tr = $(`cdn-${region}`);
  if (!r || !tr) return renderCDNTable();
  tr.outerHTML = cdnRowHTML(r);
}

$('cdn-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-speed]');
  if (!b) return;
  const region = b.dataset.speed;
  if (Object.values(state.speeds).some((s) => s.running)) return toast('One speed test at a time');
  state.speeds[region] = { running: true, mbps: 0 };
  updateCDNRow(region);
  const res = await Core.speedTest(region, (p) => {
    const cur = state.speeds[region];
    if (cur?.running) { cur.mbps = p.mbps; updateCDNRow(region); }
  });
  state.speeds[region] = { ...res, done: !res.error, running: false };
  updateCDNRow(region);
});

$('cdn-refresh').addEventListener('click', async () => {
  if (state.running) return;
  const btn = $('cdn-refresh');
  btn.disabled = true;
  state.running = true;
  state.cdns = new Map();
  state.speeds = {};
  renderCDNTable();
  try { await Core.refreshCDNs(callbacks); } finally { state.running = false; btn.disabled = false; renderCards(); }
});

// ---------------------------------------------------------------- addons
function addonPill(a) {
  if (a.level === 'skip') return '<span class="pill">Skipped</span>';
  if (a.level === 'info') return '<span class="pill lv-info">Normal</span>';
  if (a.level === 'warn') return `<span class="pill lv-warn">${a.errors?.length ? 'Errors' : 'Found nothing'}</span>`;
  return `<span class="pill lv-${a.level}">${{ ok: 'Working', down: 'Failing' }[a.level]}</span>`;
}

function addonTableHTML(sr) {
  const anime = sr.addons.some((a) => a.animeFound !== null && a.animeFound !== undefined);
  const order = { down: 0, warn: 1, ok: 2, info: 3, skip: 4 };
  const rows = [...sr.addons].sort((x, y) => order[x.level] - order[y.level]);
  const n = (a, v) => (a.kind && a.kind !== 'stream' ? '<span class="muted">—</span>' : v);
  return `<div class="card table-card"><table class="addons">
    <thead><tr><th>Addon</th><th>Result</th>
      <th class="num" title="${sr.rawOk ? 'Everything this addon found, before duplicate removal and your filters' : 'Streams shown after duplicate removal'}">${sr.rawOk ? 'Found' : 'Streams'}</th>
      ${sr.rawOk ? '<th class="num" title="How many of them made it to Nuvio">In Nuvio</th>' : ''}
      <th class="num">Instant ⚡</th>
      ${anime ? `<th class="num" title="Anime test: ${esc(sr.animeQuery)}">Anime test</th>` : ''}</tr></thead>
    <tbody>${rows.map((a) => `<tr class="${a.level === 'skip' ? 'dim' : ''}">
      <td><span class="dot lv-${a.level}"></span> <b>${esc(a.name)}</b>${a.type && a.type !== a.name ? ` <span class="muted small">${esc(a.type)}</span>` : ''}</td>
      <td class="res-cell">${addonPill(a)} <span class="res">${esc(a.detail)}</span></td>
      <td class="num">${n(a, a.found ?? a.count ?? 0)}</td>
      ${sr.rawOk ? `<td class="num">${n(a, a.shown)}</td>` : ''}
      <td class="num">${n(a, sr.rawOk ? a.foundCached : a.cached)}</td>
      ${anime ? `<td class="num">${a.animeFound === null || a.animeFound === undefined ? '<span class="muted">—</span>' : a.animeFound}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}

function renderAddons() {
  const el = $('addons-body');
  const sr = state.addons;
  const a = state.accounts;
  if (a && !a.aioMode) { el.innerHTML = '<div class="quiet">Sign in to AIOStreams on the <a class="link" data-go="accounts">Accounts</a> page first.</div>'; return; }
  if (a && a.aioMode !== 'login') {
    el.innerHTML = `<div class="card pad"><div class="card-title">See every addon separately</div>
      <p class="muted">You are signed in with a manifest URL, which only shows the combined result. Sign in with your AIOStreams <b>UUID + password</b> and Stream Check can ask AIOStreams which addon returned what — and which ones are failing.</p>
      <button class="btn primary" data-go="accounts">Go to Accounts</button></div>`;
    return;
  }
  if (!sr) { el.innerHTML = `<div class="quiet">${state.running ? 'Asking every addon…' : 'Run a check to test every addon.'}</div>`; return; }
  if (!sr.ok) { el.innerHTML = `<div class="quiet"><span class="dot lv-down"></span>${esc(sr.error)}</div>`; return; }
  const general = sr.errors.filter((e) => !e.addon);
  el.innerHTML = `
    <div class="muted small" style="margin-bottom:12px">Test search: <b>${esc(sr.type)} ${esc(sr.query)}</b> · ${sr.count} streams reach Nuvio in ${sr.secs.toFixed(1)} s${sr.animeQuery ? ` · anime test: <b>${esc(sr.animeQuery)}</b>${sr.animeError ? ` <span class="ms-bad">(failed: ${esc(sr.animeError)})</span>` : ''}` : ''}${!sr.rawOk && sr.rawError ? ` · <span class="ms-mid">raw counts unavailable: ${esc(sr.rawError)}</span>` : ''}</div>
    ${sr.addons.length ? addonTableHTML(sr) : `<div class="quiet">${esc(sr.addonsNote || 'No enabled addons found in your config.')}</div>`}
    ${general.length ? `<div class="card pad" style="margin-top:14px"><div class="card-title" style="margin-bottom:6px">Other errors AIOStreams reported</div>${general.map((e) => `<div class="stream ms-bad">${esc(e.text)}</div>`).join('')}</div>` : ''}
    ${sr.statistics?.length ? `<div class="card pad" style="margin-top:14px"><div class="card-title" style="margin-bottom:6px">AIOStreams statistics</div>${sr.statistics.map((s) => `<div class="stream">${esc(s)}</div>`).join('')}</div>` : ''}
    <p class="muted small"><b>Found</b> = everything the addon returned, asked with duplicate removal and your filters switched off (a temporary copy of your config, used for this one search and sent only to your own AIOStreams server). <b>In Nuvio</b> = what is left after AIOStreams removes duplicates and applies your filters — that is what you actually see.</p>`;
}

// ---------------------------------------------------------------- test a title
$('title-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('title-btn');
  const out = $('title-result');
  busy(btn, true);
  out.innerHTML = '<div class="card pad result"><div class="skel" style="width:40%"></div><div class="skel" style="width:70%"></div></div>';
  try {
    const r = await Core.testTitle($('title-input').value);
    if (!r.ok) {
      out.innerHTML = `<div class="card pad result"><div class="it lv-down"><span class="dot"></span><span class="lb">No answer</span><span class="dt">${esc(r.error)}</span></div></div>`;
      return;
    }
    const lv = r.count ? (r.errors.length ? 'warn' : 'ok') : 'down';
    out.innerHTML = `<div class="result">
      <div class="stat-row">
        <div class="stat"><div class="n ${lv === 'down' ? 'ms-bad' : 'ms-good'}">${r.count}</div><div class="l">playable streams</div></div>
        <div class="stat"><div class="n">${r.instant}</div><div class="l">instant ⚡ (cached)</div></div>
        <div class="stat"><div class="n ${r.secs > 20 ? 'ms-bad' : r.secs > 8 ? 'ms-mid' : ''}">${r.secs.toFixed(1)} s</div><div class="l">response time</div></div>
        <div class="stat"><div class="n ${r.errors.length ? 'ms-bad' : ''}">${r.errors.length}</div><div class="l">source errors</div></div>
      </div>
      ${r.addons?.length ? addonTableHTML(r) + '<div style="height:14px"></div>' : ''}
      ${r.errors.length ? `<div class="card pad" style="margin-bottom:14px"><div class="card-title" style="margin-bottom:6px">What AIOStreams reported</div>${r.errors.map((x) => `<div class="stream ms-bad">${esc(x.text)}</div>`).join('')}</div>` : ''}
      ${r.top.length ? `<div class="card pad"><div class="card-title" style="margin-bottom:6px">Top results <span class="muted small">(${esc(r.type)} ${esc(r.query)})</span></div>${r.top.map((x) => `<div class="stream">${esc(x)}</div>`).join('')}</div>` : ''}
      ${!r.count && !r.errors.length ? '<div class="quiet">AIOStreams answered but found nothing for this title. Check the id, or try a more popular title to see if search works at all.</div>' : ''}
    </div>`;
  } catch (err) {
    out.innerHTML = `<div class="card pad result"><div class="err">${esc(err?.message || err)}</div></div>`;
  } finally {
    busy(btn, false);
  }
});

// ---------------------------------------------------------------- accounts
async function refreshAccounts() {
  state.accounts = await Core.accounts();
  const missing = !(state.accounts.torbox && state.accounts.aioMode);
  $('acct-dot').hidden = !missing;
  $('more-dot').hidden = !missing;
  $('sheet-acct-dot').hidden = !missing;
  renderAddons();
  return state.accounts;
}

async function renderAccounts(fetchInfo) {
  const a = await refreshAccounts();
  renderPairCard(a);
  const tb = $('acct-torbox');
  const tbHead = (on) => `<div class="acct-head"><div class="acct-logo tb">TB</div><div><div class="card-title">TorBox</div><div class="muted small">API key login</div></div>
    <span class="pill ${on ? 'lv-ok' : ''}">${on ? 'Signed in' : 'Signed out'}</span></div>`;
  if (a.torbox) {
    tb.innerHTML = tbHead(true) + `<div class="kv" id="tb-kv"><div class="k">Account</div><div class="v muted">loading…</div></div>
      <button class="btn danger" id="tb-logout">Sign out</button>`;
    $('tb-logout').onclick = async () => { await Core.logoutTorbox(); state.torboxInfo = null; clearSnapshot(); toast('Signed out of TorBox'); renderAccounts(); };
    if (fetchInfo || !state.torboxInfo) {
      try { state.torboxInfo = await Core.torboxAccount(); } catch (e) { state.torboxInfo = { error: String(e?.message || e) }; }
    }
    const i = state.torboxInfo || {};
    const kv = $('tb-kv');
    if (kv) kv.innerHTML = i.error ? `<div class="k">Account</div><div class="v ms-mid">${esc(i.error)}</div>` : `
      <div class="k">Email</div><div class="v">${esc(i.email)}</div>
      <div class="k">Plan</div><div class="v">${esc(i.plan)}</div>
      <div class="k">Subscription</div><div class="v ${i.daysLeft >= 0 && i.daysLeft < 7 ? 'ms-mid' : ''}">${i.expires ? `until ${esc(fmtTime(i.expires))} · ${i.daysLeft} days left` : '—'}</div>
      <div class="k">Member since</div><div class="v">${esc(i.created ? new Date(i.created).toLocaleDateString() : '—')}</div>
      <div class="k">Downloaded</div><div class="v">${i.downloaded ? (i.downloaded / 1e12).toFixed(2) + ' TB' : '—'}</div>`;
  } else {
    tb.innerHTML = tbHead(false) + `
      <label for="tb-key">API key</label>
      <div class="field-wrap"><input id="tb-key" type="password" placeholder="Paste your TorBox API key" autocomplete="off" /><button class="eye" type="button" data-eye="tb-key">show</button></div>
      <div class="help">Find it on torbox.app → <a class="link" data-url="https://torbox.app/settings">Settings</a> → API Key. TorBox has no password login for apps — the API key is the login.</div>
      <div class="err" id="tb-err"></div>
      <button class="btn primary" id="tb-login" style="margin-top:6px"><span class="spin" hidden></span><span class="lbl">Sign in</span></button>`;
    $('tb-login').onclick = async () => {
      const btn = $('tb-login');
      busy(btn, true); $('tb-err').textContent = '';
      try {
        const warn = await Core.loginTorbox($('tb-key').value);
        toast(warn || 'Signed in to TorBox');
        state.torboxInfo = null;
        renderAccounts(true);
      } catch (e) { $('tb-err').textContent = String(e?.message || e); busy(btn, false); }
    };
    $('tb-key').onkeydown = (e) => { if (e.key === 'Enter') $('tb-login').click(); };
  }

  const aio = $('acct-aio');
  const aioHead = (on) => `<div class="acct-head"><div class="acct-logo aio">AIO</div><div><div class="card-title">AIOStreams</div><div class="muted small">UUID + password, or manifest URL</div></div>
    <span class="pill ${on ? 'lv-ok' : ''}">${on ? 'Signed in' : 'Signed out'}</span></div>`;
  if (a.aioMode) {
    aio.innerHTML = aioHead(true) + `<div class="kv">
      <div class="k">Server</div><div class="v">${esc(a.aioInstance)}</div>
      <div class="k">Signed in with</div><div class="v">${a.aioMode === 'login' ? `UUID ${esc(a.aioUuid)} + password` : 'manifest URL'}</div>
      <div class="k">Addon checks</div><div class="v">${a.aioMode === 'login' ? '<span class="ms-good">on — every addon is checked</span>' : '<span class="ms-mid">off — sign out and sign in with UUID + password to check each addon</span>'}</div>
    </div><button class="btn danger" id="aio-logout">Sign out</button>`;
    $('aio-logout').onclick = async () => { await Core.logoutAio(); state.addons = null; clearSnapshot(); toast('Signed out of AIOStreams'); renderAccounts(); };
  } else {
    const tab = state.aioTab;
    const inst = a.aioInstance || (await Core.savedInstance());
    aio.innerHTML = aioHead(false) + `
      <div class="tabs"><button class="tab ${tab === 'login' ? 'on' : ''}" data-tab="login">UUID + password</button><button class="tab ${tab === 'manifest' ? 'on' : ''}" data-tab="manifest">Manifest URL</button></div>
      ${tab === 'login' ? `
        <label for="aio-inst">Your AIOStreams server</label>
        <input id="aio-inst" list="aio-hosts" placeholder="https://aiostreams.elfhosted.com" value="${esc(inst || '')}" autocomplete="off" />
        <datalist id="aio-hosts"><option value="https://aiostreams.elfhosted.com"></datalist>
        <label for="aio-uuid">UUID</label>
        <input id="aio-uuid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" />
        <label for="aio-pw">Password</label>
        <div class="field-wrap"><input id="aio-pw" type="password" placeholder="The password you set when saving your config" autocomplete="off" /><button class="eye" type="button" data-eye="aio-pw">show</button></div>
        <div class="help">Both are on your AIOStreams configure page (the UUID is shown after you save; the password is the one you chose). This also turns on the per-addon checks.</div>`
      : `
        <label for="aio-man">Manifest URL</label>
        <input id="aio-man" placeholder="https://…/stremio/…/manifest.json" autocomplete="off" />
        <div class="help">The install URL from your AIOStreams configure page, or the one added in Nuvio. Checks AIOStreams as a whole, but not each addon.</div>`}
      <div class="err" id="aio-err"></div>
      <button class="btn primary" id="aio-login" style="margin-top:6px"><span class="spin" hidden></span><span class="lbl">Sign in</span></button>`;
    aio.querySelectorAll('[data-tab]').forEach((t) => (t.onclick = () => { state.aioTab = t.dataset.tab; renderAccounts(); }));
    $('aio-login').onclick = async () => {
      const btn = $('aio-login');
      busy(btn, true); $('aio-err').textContent = '';
      try {
        if (state.aioTab === 'login') await Core.loginAio($('aio-inst').value, $('aio-uuid').value, $('aio-pw').value);
        else await Core.loginAioManifest($('aio-man').value);
        toast('Signed in to AIOStreams');
        renderAccounts();
      } catch (e) { $('aio-err').textContent = String(e?.message || e); busy(btn, false); }
    };
    aio.querySelectorAll('input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') $('aio-login').click(); }));
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-eye]');
  if (!b) return;
  const inp = $(b.dataset.eye);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  b.textContent = inp.type === 'password' ? 'show' : 'hide';
});

// ---------------------------------------------------------------- Wi-Fi pairing
// PC: shows a QR code and asks Allow / Deny.  Phone: scans it and receives the
// sign-ins straight from the PC over the local network (see desktop/pair.go).
const PAIR_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/></svg>';

function renderPairCard(a) {
  const el = $('pair-card');
  if (Native.canHostPairing()) {
    const has = a.torbox || a.aioMode;
    el.innerHTML = `<div class="card pad pair-card">
      <div class="pair-icon">${PAIR_ICON}</div>
      <div class="pair-text"><div class="card-title">Sign in on your phone</div>
        <div class="muted small">${has ? 'Show a QR code and scan it with the Stream Check app on your phone. Your sign-ins go straight from this PC to the phone over your Wi-Fi — only after you click Allow.' : 'Sign in here first, then you can copy your sign-ins to your phone with one scan.'}</div></div>
      <button class="btn primary" id="pair-start" ${has ? '' : 'disabled'}>Show QR code</button>
    </div>`;
    $('pair-start').onclick = openPcPairing;
  } else if (Native.name === 'android' && !(a.torbox && a.aioMode)) {
    // Only useful while this phone still misses a sign-in.
    el.innerHTML = `<div class="card pad pair-card">
      <div class="pair-icon">${PAIR_ICON}</div>
      <div class="pair-text"><div class="card-title">Copy sign-ins from your PC</div>
        <div class="muted small">Signed in on your PC already? On the PC open Stream Check → Accounts → <b>Show QR code</b>, then scan it here. Both devices must be on the same Wi-Fi.</div></div>
      <button class="btn primary" id="pair-scan">Scan QR code</button>
    </div>`;
    $('pair-scan').onclick = openScanner;
  } else el.innerHTML = '';
}

function modal(html) {
  $('modal-box').innerHTML = html;
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; $('modal-box').innerHTML = ''; }

// ---- PC side
let pairTimer = null;
async function openPcPairing() {
  modal('<div class="pair-modal"><div class="skel" style="width:60%"></div><div class="skel" style="width:40%"></div></div>');
  const info = await Native.startPairing();
  if (info.error) return pairModalMessage('down', 'Could not start pairing', info.error);
  const end = Date.parse(info.expiresAt);
  modal(`<div class="pair-modal">
    <div class="card-title">Scan with your phone</div>
    <img class="pair-qr" src="${esc(info.qr)}" alt="Pairing QR code" />
    <div class="pair-status" id="pair-status"><span class="spin dim"></span> Waiting for your phone… <span class="muted" id="pair-left"></span></div>
    <ol class="pair-steps">
      <li>On your phone, open <b>Stream Check</b> → Accounts → <b>Scan QR code</b>.<br><span class="muted small">No app yet? Scan with the camera — it offers the download.</span></li>
      <li>Keep the phone on the same Wi-Fi as this PC (${esc(info.hosts.join(', '))}).</li>
      <li>If Windows asks, allow Stream Check on <b>private networks</b>.</li>
    </ol>
    <button class="btn ghost" id="pair-cancel">Cancel</button>
  </div>`);
  $('pair-cancel').onclick = () => { Native.stopPairing(); stopPairTimer(); closeModal(); };
  stopPairTimer();
  pairTimer = setInterval(() => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    const left = $('pair-left');
    if (left) left.textContent = `· ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
  }, 500);
}
function stopPairTimer() { clearInterval(pairTimer); pairTimer = null; }

function pairModalMessage(level, title, text) {
  stopPairTimer();
  modal(`<div class="pair-modal">
    <div class="v-icon pair-result lv-${level}">${ICONS[level] || ICONS.idle}</div>
    <div class="card-title">${esc(title)}</div>
    <div class="muted" style="margin:6px 0 16px">${esc(text)}</div>
    <button class="btn primary" id="pair-close">Close</button>
  </div>`);
  $('pair-close').onclick = closeModal;
}

function onPairEvent(e) {
  if ($('modal').hidden) return;
  if (e.state === 'request') {
    stopPairTimer();
    modal(`<div class="pair-modal">
      <div class="card-title">Allow this phone?</div>
      <div class="pair-device">${esc(e.device)}</div>
      <div class="muted" style="margin:6px 0 16px">wants to copy your TorBox and AIOStreams sign-ins from this PC. Only allow it if this is your phone and you just scanned the code.</div>
      <div class="row center"><button class="btn primary" id="pair-allow">Allow</button><button class="btn danger" id="pair-deny">Deny</button></div>
    </div>`);
    $('pair-allow').onclick = () => { Native.answerPairing(true); modal('<div class="pair-modal"><span class="spin dim"></span> Sending…</div>'); };
    $('pair-deny').onclick = () => Native.answerPairing(false);
  } else if (e.state === 'done') pairModalMessage('ok', 'Phone signed in', `${e.device} now has your sign-ins. You can close this window.`);
  else if (e.state === 'denied') pairModalMessage('warn', 'Pairing refused', 'Nothing was sent to the phone.');
  else if (e.state === 'expired') pairModalMessage('warn', 'QR code expired', 'Nothing was sent. Click Show QR code to try again.');
}

// ---- phone side
let scanStream = null, scanLoop = null;
async function openScanner() {
  modal(`<div class="pair-modal">
    <div class="card-title">Scan the QR code on your PC</div>
    <div class="scan-box"><video id="scan-video" playsinline muted></video><div class="scan-frame"></div></div>
    <div class="muted small" id="scan-msg">Point your camera at the QR code.</div>
    <button class="btn ghost" id="scan-cancel">Cancel</button>
  </div>`);
  $('scan-cancel').onclick = () => { stopScanner(); closeModal(); };
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    $('scan-msg').innerHTML = `<span class="ms-bad">Camera not available (${esc(e.name || e.message || e)}).</span> Allow camera access for Stream Check in Android settings, or scan the code with your normal camera app instead.`;
    return;
  }
  const video = $('scan-video');
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  scanLoop = setInterval(() => {
    if (!video.videoWidth) return;
    const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (code?.data) {
      try { Core.parsePair(code.data); } catch (e) { $('scan-msg').textContent = e.message; return; }
      stopScanner();
      phonePair(code.data);
    }
  }, 200);
}
function stopScanner() {
  clearInterval(scanLoop); scanLoop = null;
  scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null;
}

async function phonePair(text) {
  const steps = { connecting: 'Looking for your PC on the Wi-Fi…', waiting: 'Found it — now click <b>Allow</b> on your PC.' };
  const show = (state) => modal(`<div class="pair-modal"><span class="spin dim"></span><div style="margin-top:10px">${steps[state] || ''}</div></div>`);
  show('connecting');
  try {
    const r = await Core.pairWithPC(text, (s) => steps[s] && show(s));
    const what = [r.torbox && 'TorBox', r.aio && `AIOStreams${r.aioMode === 'login' ? ' (with addon checks)' : ''}`].filter(Boolean).join(' and ');
    pairModalMessage('ok', 'Signed in', what ? `Copied ${what} from your PC. Press Check now whenever something will not play.` : 'Your PC had no sign-ins to copy.');
    state.torboxInfo = null;
    await renderAccounts(true);
  } catch (e) {
    pairModalMessage('down', 'Pairing did not work', String(e?.message || e));
  }
}

// ---------------------------------------------------------------- updates
// Windows: download + verify in the app, then "Restart now" swaps the .exe.
// Android: the native Updater plugin downloads the APK and opens the installer
// (same flow and error texts as ElderKeep's).
let updateInfo = null;
const fmtMB = (b) => (b / 1e6).toFixed(1) + ' MB';
const notesText = (md) => String(md || '')
  .replace(/^#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();

async function checkUpdates(force) {
  const btn = $('update-check');
  if (force) busy(btn, true);
  try {
    const u = await Core.checkForUpdate(force);
    updateInfo = u;
    const st = $('update-status');
    if (u.unsupported) st.textContent = 'Updates are installed from the GitHub page in this version.';
    else if (u.available) st.innerHTML = `<span class="ms-good">Version ${esc(u.latest)} is available</span> — you have ${esc(u.current)}.`;
    else if (u.error && force) st.innerHTML = `<span class="ms-mid">Could not check: ${esc(u.error)}</span>`;
    else st.textContent = `You have the latest version (${u.current}).`;
    renderUpdateBanner();
    if (force && !u.available && !u.error) toast('Stream Check is up to date');
  } finally { if (force) busy(btn, false); }
}

function renderUpdateBanner() {
  const el = $('update-banner');
  const u = updateInfo;
  if (!u?.available || sessionStorage.getItem('sc_hide_update') === u.latest) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="update-banner">
    <div class="ub-text"><b>Stream Check ${esc(u.latest)} is available</b> <span class="muted small">— you have ${esc(u.current)}</span></div>
    <button class="btn primary sm" id="ub-install">${Native.name === 'android' ? 'Install update' : 'Update now'}</button>
    <button class="ub-x" id="ub-hide" title="Hide until next start">×</button>
  </div>`;
  $('ub-install').onclick = openUpdateModal;
  $('ub-hide').onclick = () => { sessionStorage.setItem('sc_hide_update', u.latest); el.hidden = true; };
}

function openUpdateModal() {
  const u = updateInfo;
  if (!u) return;
  const manual = !u.asset;
  modal(`<div class="pair-modal">
    <div class="card-title">Update to Stream Check ${esc(u.latest)}</div>
    <div class="muted small">You have ${esc(u.current)}${u.asset?.size ? ` · download ${fmtMB(u.asset.size)}` : ''}</div>
    ${u.notes ? `<div class="update-notes">${esc(notesText(u.notes))}</div>` : ''}
    <div id="upd-area">
      ${manual ? '<div class="muted small" style="margin-bottom:12px">This release has no file for this device — open the release page instead.</div>' : ''}
      <div class="row center">
        ${manual ? '' : '<button class="btn primary" id="upd-go">Download and install</button>'}
        <button class="btn ghost" id="upd-page">Release page ↗</button>
        <button class="btn ghost" id="upd-later">Later</button>
      </div>
    </div>
  </div>`);
  $('upd-page').onclick = () => Native.open(u.page);
  $('upd-later').onclick = closeModal;
  if (!manual) $('upd-go').onclick = () => (Native.name === 'android' ? androidInstall(u) : windowsInstall(u));
}

async function windowsInstall(u) {
  const area = $('upd-area');
  area.innerHTML = `<div class="progress"><div id="upd-bar"></div></div><div class="muted small" id="upd-msg">Downloading…</div>`;
  Native.onUpdateProgress((p) => {
    const bar = $('upd-bar'), msg = $('upd-msg');
    if (!bar || !msg) return;
    const pct = p.total > 0 ? Math.min(100, (p.got / p.total) * 100) : 0;
    bar.style.width = pct.toFixed(0) + '%';
    msg.textContent = `Downloading… ${fmtMB(p.got)}${p.total > 0 ? ' of ' + fmtMB(p.total) : ''}`;
  });
  const r = await Native.downloadUpdate(u.asset.url, u.asset.digest);
  if (!r.ok) return updateFailed(u, r.error);
  area.innerHTML = `<div class="muted" style="margin:12px 0">Downloaded and verified (SHA-256 matches the release). Stream Check restarts on the new version.</div>
    <div class="row center"><button class="btn primary" id="upd-restart">Restart now</button><button class="btn ghost" id="upd-later2">Later</button></div>`;
  $('upd-later2').onclick = closeModal;
  $('upd-restart').onclick = async () => {
    $('upd-restart').disabled = true;
    const res = await Native.installUpdate();
    if (!res.ok) updateFailed(u, res.error);
  };
}

const ANDROID_UPDATE_ERR = {
  permission: 'Allow "Install unknown apps" for Stream Check in the screen that just opened, then come back — the install continues by itself.',
  download: 'The download failed. Check your connection and try again.',
  missing: 'The download failed. Check your connection and try again.',
  installer: 'Could not open the installer — use Release page to download it in your browser.',
};
let androidUpdating = false;
async function androidInstall(u) {
  if (androidUpdating) return; // a second tap must not start a second download (GitHub abuse limit)
  androidUpdating = true;
  const area = $('upd-area');
  area.innerHTML = `<div style="margin:12px 0"><span class="spin dim"></span> Downloading ${esc(u.latest)}… Android opens the installer when it is done (you can follow it in the notifications).</div>
    <div class="row center"><button class="btn ghost" id="upd-close">Close</button></div>`;
  $('upd-close').onclick = closeModal;
  try {
    const ok = await Native.androidUpdate(u.asset.url, u.latest, (reason) => {
      androidUpdating = false;
      updateFailed(u, ANDROID_UPDATE_ERR[reason] || ANDROID_UPDATE_ERR.download, reason === 'permission' ? 'warn' : 'down');
    });
    if (!ok) { androidUpdating = false; Native.open(u.asset.url); }
  } catch (e) {
    androidUpdating = false;
    updateFailed(u, ANDROID_UPDATE_ERR.download);
  }
}

function updateFailed(u, text, level = 'down') {
  modal(`<div class="pair-modal">
    <div class="v-icon pair-result lv-${level}">${ICONS[level]}</div>
    <div class="card-title">${level === 'warn' ? 'One more step' : 'Update did not finish'}</div>
    <div class="muted" style="margin:6px 0 16px">${esc(text)}</div>
    <div class="row center"><button class="btn primary" id="upd-retry">Try again</button><button class="btn ghost" id="upd-page2">Release page ↗</button><button class="btn ghost" id="upd-close2">Close</button></div>
  </div>`);
  $('upd-retry').onclick = openUpdateModal;
  $('upd-page2').onclick = () => Native.open(u.page);
  $('upd-close2').onclick = closeModal;
}

$('update-check').addEventListener('click', () => checkUpdates(true));

// ---------------------------------------------------------------- Android back button
let exitAsking = false;
function onBackButton() {
  if (!$('modal').hidden) {
    if (exitAsking) { exitAsking = false; closeModal(); return; }   // back on the exit question = No
    stopScanner?.(); Native.stopPairing(); stopPairTimer?.(); closeModal(); return;
  }
  if (!$('sheet').hidden) return closeSheet();
  exitAsking = true;
  modal(`<div class="pair-modal">
    <div class="card-title">Exit Stream Check?</div>
    <div class="row center" style="margin-top:16px"><button class="btn primary" id="exit-yes">Yes</button><button class="btn ghost" id="exit-no">No</button></div>
  </div>`);
  $('exit-yes').onclick = () => Native.exitApp();
  $('exit-no').onclick = () => { exitAsking = false; closeModal(); };
}

// ---------------------------------------------------------------- start
window.addEventListener('error', (e) => setVerdict({ level: 'down', title: 'Stream Check hit a bug', message: String(e.message) }));
window.addEventListener('unhandledrejection', (e) => setVerdict({ level: 'down', title: 'Stream Check hit a bug', message: String(e.reason?.message || e.reason) }));

(async function start() {
  document.querySelectorAll('.app-version').forEach((el) => (el.textContent = 'v' + VERSION));
  document.querySelectorAll('[data-repo]').forEach((el) => (el.dataset.url = REPO_URL));
  const plat = await Native.ready();
  document.body.dataset.platform = plat.name;
  $('about-platform').textContent = { windows: 'Windows', android: 'Android', browser: 'Browser preview' }[plat.name] || plat.name;
  renderCards();
  renderStatus();
  Native.onPair(onPairEvent);
  Native.onBack(onBackButton);
  restoreSnapshot();
  const animeToggle = $('anime-toggle');
  animeToggle.checked = await Core.getAnimeTest();
  animeToggle.onchange = async () => {
    await Core.setAnimeTest(animeToggle.checked);
    toast(animeToggle.checked ? 'Anime test on — used from the next check' : 'Anime test off');
  };
  Native.onLink((url) => { if (/pair/i.test(url)) { showPage('accounts'); phonePair(url); } });
  const a = await refreshAccounts();
  renderPairCard(a);
  if (!a.torbox && !a.aioMode) {
    showPage('accounts');
    toast(Native.name === 'android' ? 'Sign in here — or scan the QR code from Stream Check on your PC' : 'Sign in to TorBox and AIOStreams to get the full check');
  }
  // No automatic check: every check hits TorBox, every CDN and a real
  // AIOStreams search, so it only runs when the user presses Check now.
  // The update check is different — one request to GitHub, at most hourly.
  checkUpdates(false).catch(() => {});
})();
