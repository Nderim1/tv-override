'use strict';
/* tv-override control center. Vanilla JS, no build step.
   Data: GET /api/state, /api/tv/:name, /api/tv/:name/apps, /api/tv/:name/runs/:id
   Live: SSE /api/events (workflow events from the dashboard's own runs and mirrored CLI runs). */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  tvs: [], selected: null, detail: null, lastRecord: null, viewRun: null,
  apps: null, appsLoading: false, appsError: null, appsFilter: 'all', appsQuery: '', appsMem: false,
  live: {}, measuring: false, opts: { reboot: true, track: true }, store: null, storeError: null,
  agent: { items: [], seen: null },
  keys: null, keysError: null, capture: { state: null, presses: [], until: 0 },
  prep: { data: null, loading: false, error: null, open: null, show: null },
  screen: { live: false, interval: 2000, timer: null, busy: false, url: null, info: '', error: null, auto: false },
  cam: null,  // phone camera status (TVs without screenshots)
  tz: null, tzLog: [],  // Samsung: own apps (Developer Mode) status and job log
};

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'X-Token': window.TOKEN, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}

/* ------------------------------------------------------------------ formatting */

const fmtMB = (v) => (v == null ? '–' : `${Math.round(v).toLocaleString()}`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const date = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const STATUS = {
  done: ['✓', 'done'], ok: ['✓', 'ok'], error: ['✖', 'error'], running: ['◌', 'running'], todo: ['·', 'to do'],
  manual: ['⚠', 'your turn'], blocked: ['⏸', 'blocked'], confirm: ['?', 'needs ok'], declined: ['✕', 'declined'],
  skipped: ['–', 'skipped'], waiting: ['⚠', 'waiting on you'], stopped: ['■', 'stopped'], pending: ['○', 'pending'],
  'needs-confirm': ['?', 'needs ok'],
};
function explainBtn(question) {
  return `<button class="explain" data-action="explain" data-q="${esc(question)}" title="Ask the agent to explain this" aria-label="Explain this">?</button>`;
}

function st(status) {
  const [icon, label] = STATUS[status] || ['·', status];
  const cls = status === 'ok' ? 'done' : status === 'needs-confirm' ? 'confirm' : status === 'stopped' ? 'skipped' : status;
  return `<span class="st st-${cls}"><span class="${status === 'running' ? 'spin' : ''}">${icon}</span>${esc(label)}</span>`;
}

/* ------------------------------------------------------------------ live state from events */

function live(tv) {
  return (S.live[tv] ||= { run: null, mode: null, source: null, state: null, phases: {}, rounds: [], perf: {}, job: null, waiting: null, log: [], record: null });
}

function logLine(L, ev, text, level = '') {
  L.log.push({ t: ev.time || new Date().toISOString(), text, level });
  if (L.log.length > 600) L.log.splice(0, L.log.length - 600);
}

function handleAgentEvent(ev) {
  if (ev.event === 'presence') S.agent.seen = ev.seen;
  else if (ev.item) {
    const i = S.agent.items.findIndex((x) => x.id === ev.item.id);
    if (i >= 0) S.agent.items[i] = ev.item; else S.agent.items.push(ev.item);
    if (ev.item.type === 'ask' && ev.item.status === 'open') S.agent.seen = ev.item.created;
  }
  renderAgentChip(); renderAgent(); scheduleFleet();
}

function handleKeyEvent(ev) {
  if (ev.tv !== S.selected) return;
  const C = S.capture;
  if (ev.type === 'keycapture') {
    C.state = ev.state;
    if (ev.state === 'listening') { C.presses = []; C.until = Date.now() + ev.seconds * 1000; }
  } else {
    const p = C.presses.find((x) => x.scan === ev.scan);
    if (p) p.count++; else C.presses.push({ ...ev, count: 1 });
  }
  renderKeys();
}

function handleEvent(ev) {
  if (ev && ev.type === 'agent') return handleAgentEvent(ev);
  if (ev && ev.type === 'phonecam') return handleCamEvent(ev);
  if (ev && ev.type === 'tizen') return handleTizenEvent(ev);
  if (ev && (ev.type === 'keypress' || ev.type === 'keycapture')) return handleKeyEvent(ev);
  if (ev && ev.type === 'prepare') { if (ev.tv === S.selected) loadPrep(false); return; }
  if (!ev || !ev.tv) return;
  const L = live(ev.tv);
  switch (ev.type) {
    case 'run':
      if (ev.status === 'running') {
        Object.assign(L, { run: ev.run, mode: ev.mode, steps: ev.steps, source: ev.source || 'ui', state: 'running', phases: {}, rounds: [], perf: {}, waiting: null, record: null });
        logLine(L, ev, `▶ RUN ${ev.run} · ${ev.mode} · from ${ev.source === 'cli' ? 'terminal' : 'dashboard'}`, 'phase');
      } else {
        L.state = ev.status;
        L.record = ev.record;
        L.waiting = null;
        logLine(L, ev, `■ RUN ${ev.status.toUpperCase()}${ev.record?.error ? ' – ' + ev.record.error : ''}`, ev.status === 'error' ? 'error' : 'phase');
        scheduleRefresh(ev.tv);
      }
      break;
    case 'phase':
      L.phases[ev.name] = { status: ev.status, detail: ev.detail };
      if (ev.status !== 'done' || ev.name === 'reboot') logLine(L, ev, `» ${ev.name} ${ev.status}${ev.detail ? ': ' + ev.detail : ''}`, ev.status === 'error' ? 'error' : 'phase');
      else logLine(L, ev, `» ${ev.name} done`, 'dim');
      break;
    case 'round':
      L.rounds[ev.n] = ev.actions.map((a) => ({ ...a }));
      logLine(L, ev, `— ${ev.execute ? 'round' : 'plan'} ${ev.n + 1}: ${ev.actions.length} action(s)`, 'dim');
      if (!ev.execute) ev.actions.forEach((a) => logLine(L, ev, `  [${a.status}] ${a.action} ${a.target}${a.detail ? ' — ' + a.detail : ''}`));
      break;
    case 'action': {
      const r = L.rounds[ev.n];
      if (r && r[ev.index]) Object.assign(r[ev.index], ev);
      if (ev.status !== 'running') logLine(L, ev, `  [${ev.status}] ${ev.action} ${ev.target}${ev.detail ? ' — ' + ev.detail : ''}`, ev.status === 'error' ? 'error' : ['manual', 'blocked', 'declined'].includes(ev.status) ? 'warn' : '');
      break;
    }
    case 'perf':
      L.perf[ev.which] = ev.data;
      logLine(L, ev, `◆ perf ${ev.which}: RAM ${ev.data.mem_available_mb}/${ev.data.mem_total_mb} MB free · swap ${ev.data.swap_used_mb} MB · load ${ev.data.load1}`, 'phase');
      break;
    case 'waiting':
      L.waiting = ev.items;
      logLine(L, ev, `⚠ waiting on you: ${ev.items.map((a) => a.detail).join(' | ')}`, 'warn');
      break;
    case 'job':
      L.job = ['finished', 'ok', 'error', 'stopped', 'waiting-done'].includes(ev.state) && !ev.confirm && !ev.waiting ? null : ev;
      if (ev.confirm) logLine(L, ev, `? approve ${ev.confirm.length} uninstall(s) in the dashboard`, 'warn');
      if (ev.state === 'finished') L.job = null;
      break;
    case 'log':
      logLine(L, ev, ev.msg, ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : '');
      break;
  }
  if (ev.tv === S.selected) scheduleRender();
  scheduleFleet();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderLive();
  });
}
let fleetQueued = false;
function scheduleFleet() {
  if (fleetQueued) return;
  fleetQueued = true;
  setTimeout(() => { fleetQueued = false; renderFleet(); }, 300);
}
const refreshTimers = {};
function scheduleRefresh(tv) {
  clearTimeout(refreshTimers[tv]);
  refreshTimers[tv] = setTimeout(async () => {
    await loadState();
    if (tv === S.selected) {
      await loadDetail(tv);
      renderLive(); renderHistory(); renderDanger();
      loadStore(); loadApps(); loadKeys();
    }
  }, 600);
}

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(window.TOKEN)}`);
  let replaying = true;
  es.onopen = () => { S.live = {}; replaying = true; $('#link').classList.add('on'); loadAgent(); };
  es.onerror = () => $('#link').classList.remove('on');
  es.addEventListener('replayed', () => { replaying = false; renderFleet(); if (S.selected) renderLive(); });
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (replaying && ['agent', 'keypress', 'keycapture', 'prepare'].includes(ev.type)) return;  // loaded via the API instead
    if (replaying) {
      // rebuild quietly; render once at the end of the replay
      const sel = S.selected; S.selected = null; handleEvent(ev); S.selected = sel;
    } else handleEvent(ev);
  };
}

/* ------------------------------------------------------------------ loading */

async function loadAgent() {
  try {
    const d = await api('/api/agent');
    S.agent = { items: d.items, seen: d.agent_seen };
    renderAgentChip(); renderAgent(); renderFleet();
  } catch (e) { /* server restarting */ }
}

async function loadState() {
  try {
    const data = await api('/api/state');
    S.tvs = data.tvs;
    renderFleet();
  } catch (e) { toast(e.message, true); }
}

async function loadDetail(name) {
  S.detail = await api(`/api/tv/${name}`);
  const withPerf = S.detail.runs.find((r) => r.mem_before != null || r.mem_after != null);
  S.lastRecord = withPerf ? await api(`/api/tv/${name}/runs/${withPerf.id}`).catch(() => null) : null;
}

async function loadApps(mem = S.appsMem) {
  if (!S.selected || isNet()) return;
  const tv = S.detail?.summary;
  if (tv && !onlineOf(tv.name)) { S.apps = null; S.appsError = 'TV offline'; renderApps(); return; }
  S.appsLoading = true; S.appsError = null; renderApps();
  try {
    const name = S.selected;
    const data = await api(`/api/tv/${name}/apps${mem ? '?mem=1' : ''}`);
    if (name !== S.selected) return;
    S.apps = data.rows; S.appsMem = mem;
  } catch (e) { S.appsError = e.message; }
  S.appsLoading = false;
  renderApps();
}

async function loadStore() {
  if (!S.selected || isNet()) return;
  if (!onlineOf(S.selected)) { S.store = null; S.storeError = 'TV offline'; renderStore(); return; }
  S.storeError = null;
  try {
    const name = S.selected;
    const d = await api(`/api/tv/${name}/store`);
    if (name === S.selected) S.store = d;
  } catch (e) { S.storeError = e.message; }
  renderStore();
}

async function loadKeys() {
  if (!S.selected || isNet()) return;
  if (!onlineOf(S.selected)) { S.keys = null; S.keysError = 'TV offline'; renderKeys(); return; }
  S.keysError = null;
  try {
    const name = S.selected;
    const d = await api(`/api/tv/${name}/keys`);
    if (name === S.selected) S.keys = d;
  } catch (e) { S.keysError = e.message; }
  renderKeys();
}

const isNet = () => S.detail && S.detail.summary.platform && S.detail.summary.platform !== 'adb';

const onlineOf = (name) => S.tvs.find((t) => t.name === name)?.online;

async function selectTv(name) {
  S.selected = name; S.viewRun = null; S.apps = null; S.appsError = null; S.keys = null; S.store = null;
  S.capture = { state: null, presses: [], until: 0 };
  clearTimeout(S.screen.timer);
  if (S.screen.url) URL.revokeObjectURL(S.screen.url);
  Object.assign(S.screen, { live: false, url: null, info: '', error: null, auto: false, busy: false });
  S.prep = { data: null, loading: false, error: null, open: null, show: null };
  location.hash = `tv=${name}`;
  renderFleet();
  $('#main').innerHTML = `<div class="panel"><span class="spin">◌</span> loading ${esc(name)}…</div>`;
  try {
    await loadDetail(name);
  } catch (e) { toast(e.message, true); return; }
  if (isNet()) {
    renderMainNet();
    renderAgent();
    loadPrep();
    loadDial();
    loadCam();
    if (S.detail.summary.platform === 'tizen') { S.tz = null; S.tzLog = []; loadTizen(); }
    return;
  }
  renderMain();
  renderAgent();
  loadPrep();
  loadStore();
  loadApps();
  loadKeys();
  screenTick();
}

/* ------------------------------------------------------------------ fleet */

function renderFleet() {
  const el = $('#fleet');
  const runs = S.tvs.reduce((n, t) => n + t.runs, 0);
  const freed = S.tvs.reduce((n, t) => n + (t.ram_freed_mb > 0 ? t.ram_freed_mb : 0), 0);
  const online = S.tvs.filter((t) => t.online).length;
  el.innerHTML = `
    <div class="fleet-stats">
      <div class="fleet-stat"><div class="v">${S.tvs.length}</div><div class="k">TVs</div></div>
      <div class="fleet-stat"><div class="v">${online}</div><div class="k">online</div></div>
      <div class="fleet-stat"><div class="v">${runs}</div><div class="k">runs</div></div>
    </div>
    ${freed ? `<div class="hint" style="margin:-6px 0 12px">≈ ${fmtMB(freed)} MB RAM freed across the fleet (last measured runs)</div>` : ''}
    <div class="fleet-label">// FLEET</div>
    ${S.tvs.map((t) => {
      const L = S.live[t.name];
      const busy = (L && L.state === 'running') || t.job;
      const last = t.last_run;
      return `<button class="tv-card ${t.name === S.selected ? 'active' : ''}" data-action="select" data-tv="${esc(t.name)}">
        <div class="name"><span>${esc(t.name)}${openAsks(t.name, true).length ? ' <span class="fleet-badge">◆ agent asks</span>' : ''}</span><span class="online ${t.online ? 'on' : ''}">${t.online ? 'ONLINE' : 'OFFLINE'}</span></div>
        <div class="meta">${esc(t.model || t.host)}</div>
        <div class="meta">${esc(t.host)} · ${t.platform && t.platform !== 'adb' ? `<span class="chip">${esc(t.platform)} · no ADB</span>` : esc((t.presets || []).join(', ') || 'no presets')}</div>
        <div class="foot">
          <span>${busy ? '<span class="busy">● running</span>' : last ? `${st(last.outcome)} ${esc(ago(last.finished))}` : '<span class="dim">no runs yet</span>'}</span>
          <span title="RAM available at last measurement">${t.perf ? `${fmtMB(t.perf.mem_available_mb)} MB free` : ''}</span>
        </div>
      </button>`;
    }).join('') || '<div class="empty">No TVs yet. Click + ADD TV.</div>'}
    <div class="hint" style="margin-top:14px">Profiles live in <code>profiles/</code>. Runs from the terminal (<code>./tvctl apply</code>) show up here live.</div>`;
}

/* ------------------------------------------------------------------ main skeleton */

function renderMain() {
  if (!S.selected || !S.detail) {
    $('#main').innerHTML = `<div class="welcome"><pre>
 ████████╗██╗   ██╗
 ╚══██╔══╝██║   ██║   override
    ██║   ╚██╗ ██╔╝   control center
    ██║    ╚████╔╝
    ╚═╝     ╚═══╝</pre>
      <p class="hint">Pick a TV on the left, or add one.</p>
      <button class="btn btn-primary" data-action="add-tv">+ ADD TV</button></div><section id="sec-agent"></section>`;
    renderAgent();
    return;
  }
  $('#main').innerHTML = `
    <section class="panel" id="sec-head"></section>
    <section class="panel" id="sec-prep"></section>
    <section class="panel" id="sec-screen"></section>
    <section id="sec-agent"></section>
    <section id="sec-alert"></section>
    <section class="panel" id="sec-perf"></section>
    <section class="panel" id="sec-pipeline"></section>
    <section class="panel" id="sec-keys"></section>
    <section class="panel" id="sec-console">
      <div class="panel-head"><h2 class="panel-title"><b>[06]</b>console</h2><span class="hint">live workflow log</span></div>
      <div class="console" id="console" aria-live="polite"></div>
    </section>
    <section class="panel" id="sec-store"></section>
    <section class="panel" id="sec-apps"></section>
    <section class="panel" id="sec-history"></section>
    <section class="panel danger" id="sec-danger"></section>`;
  renderLive();
  renderPrep();
  renderScreen();
  renderStore();
  renderApps();
  renderKeys();
  renderHistory();
  renderDanger();
}

function renderLive() {
  if (!$('#sec-head')) return;
  if (isNet()) { renderHeadNet(); return; }
  renderHead();
  renderAlert();
  renderPerf();
  renderPipeline();
  renderConsole();
}

/* ------------------------------------------------------------------ header + controls */

function busyState() {
  const L = S.live[S.selected];
  const job = S.tvs.find((t) => t.name === S.selected)?.job || L?.job;
  return { L, job, running: (L && L.state === 'running') || !!job, cli: L && L.state === 'running' && L.source === 'cli' };
}

function renderHead() {
  const sum = S.detail.summary, prof = S.detail.profile;
  const { running, cli, L } = busyState();
  const on = onlineOf(sum.name);
  const dis = running || !on ? 'disabled' : '';
  $('#sec-head').innerHTML = `
    <div class="tv-head">
      <div>
        <h1 class="tv-title"><span class="prompt">&gt;</span>${esc(sum.name)}</h1>
        <div class="tv-sub">${esc(sum.model)} · ${esc(sum.host)}:${sum.port}</div>
        <div class="chips">
          <span class="online ${on ? 'on' : ''}">${on ? 'ONLINE' : 'OFFLINE'}</span>
          ${(sum.presets || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}
          <span class="chip accent">launcher: ${esc(prof.home.launcher || 'stock')}</span>
          ${prof.home.screensaver ? `<span class="chip">screensaver: ${esc(prof.home.screensaver)}</span>` : ''}
          ${running ? `<span class="chip busy">● ${esc(L?.mode || 'run')} in progress${cli ? ' (terminal)' : ''}</span>` : ''}
        </div>
      </div>
      <div class="controls">
        <div class="row">
          <button class="btn btn-primary" data-action="run-picker" ${dis}>▶ RUN WORKFLOW…</button>
          <button class="btn" data-action="measure" ${dis || (S.measuring ? 'disabled' : '')}>${S.measuring ? '<span class="spin">◌</span> MEASURING' : 'MEASURE'}</button>
          <button class="btn" data-action="run" data-mode="verify" ${dis}>REBOOT &amp; VERIFY</button>
          ${running && !cli ? '<button class="btn btn-danger" data-action="stop">■ STOP</button>' : ''}
        </div>
        ${!on ? '<span class="hint">TV unreachable: switched off or in standby? If it got a new address, + ADD TV › SCAN finds it and offers to update this profile.</span>' : ''}
      </div>
    </div>
    <details class="profile" style="margin-top:12px"><summary>profile · profiles/${esc(sum.name)}.toml</summary>
      <pre class="code">${esc(S.detail.profile_text)}</pre>
      <div class="hint">Change app decisions below, or edit the file / ask the agent. Every run re-applies this profile.</div>
    </details>`;
}

/* ------------------------------------------------------------------ action required */

function renderAlert() {
  const { L, job } = busyState();
  const el = $('#sec-alert');
  const needsYou = (job && (job.confirm || job.waiting)) || (L && L.state === 'running' && L.waiting);
  if (needsYou && !S.screen.live && !S.screen.auto) { S.screen.auto = true; setLive(true); }  // show where they are on the TV
  if (!needsYou) S.screen.auto = false;
  if (job && job.confirm) {
    el.innerHTML = `<div class="alert" role="alert">
      <div class="alert-title">⚠ ACTION REQUIRED · APPROVE UNINSTALLS</div>
      <p class="hint" style="margin:6px 0 0">Uninstalling deletes the app and its data (logins, settings). Disabling would be reversible; this is not.</p>
      <ul class="confirm-list">${job.confirm.map((a, i) => `<li><label><input type="checkbox" data-confirm="${i}" checked>
        <span><span class="pkg-name">${esc(a.target)}</span><br><span class="pkg">${esc(a.detail)}</span></span></label></li>`).join('')}</ul>
      <div class="row">
        <button class="btn btn-warn" data-action="confirm">APPROVE SELECTED</button>
        <button class="btn" data-action="confirm-none">KEEP ALL</button>
        <button class="btn btn-danger" data-action="stop">STOP RUN</button>
      </div></div>`;
    return;
  }
  const waiting = (job && job.waiting) || (L && L.state === 'running' && L.waiting);
  if (waiting && waiting.length) {
    const fromCli = !job && L && L.source === 'cli';
    el.innerHTML = `<div class="alert" role="alert">
      <div class="alert-title">⚠ ACTION REQUIRED · ON THE TV</div>
      <ol>${waiting.map((a) => `<li>${esc(a.detail)} ${explainBtn(`I'm asked to do this on ${S.selected}: "${a.detail}" (${a.step} · ${a.target}). Why is it needed and how exactly do I do it?`)}<br><span class="pkg">${esc(a.step)} · ${esc(a.target)} · ${a.status === 'blocked' ? 'blocked until the step above is done' : 'needs you'}</span></li>`).join('')}</ol>
      ${fromCli ? '<p class="hint">This run was started from the terminal: answer there (press Enter to re-check).</p>' : `
      <div class="row">
        <button class="btn btn-warn" data-action="continue">✓ I DID IT · RE-CHECK</button>
        <button class="btn" data-action="stop">STOP HERE</button>
      </div>`}</div>`;
    return;
  }
  const rec = L?.record;
  if (rec && rec.outcome === 'waiting' && rec.summary?.waiting?.length && !S.viewRun) {
    el.innerHTML = `<div class="alert"><div class="alert-title">⚠ LAST RUN ENDED WAITING ON YOU</div>
      <ol>${rec.summary.waiting.map((a) => `<li>${esc(a.detail)}</li>`).join('')}</ol>
      <div class="row"><button class="btn btn-warn" data-action="run" data-mode="apply">▶ RUN AGAIN</button></div></div>`;
    return;
  }
  el.innerHTML = '';
}

/* ------------------------------------------------------------------ performance */

function currentPerf() {
  const L = S.live[S.selected];
  const rec = S.viewRun || null;
  if (rec) return { before: rec.perf_before, after: rec.perf_after, label: `run ${rec.id}` };
  if (L && (L.perf.before || L.perf.after)) return { before: L.perf.before, after: L.perf.after, label: `run ${L.run}` };
  const last = S.lastRecord;
  const latest = S.detail.summary.perf;
  if (last && latest && last.perf_after && latest.time > last.perf_after.time) {
    return { before: null, after: latest, label: `measured ${ago(latest.time)} · last run ${last.id} in history` };
  }
  if (last) return { before: last.perf_before, after: last.perf_after || latest, label: `last run ${last.id}` };
  return { before: null, after: latest, label: latest ? `measured ${ago(latest.time)}` : 'not measured yet' };
}

function delta(before, after, unit, betterHigher = true, digits = 0) {
  if (before == null || after == null) return '';
  const d = after - before;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return `<span class="d">± 0 vs before</span>`;
  const good = betterHigher ? d > 0 : d < 0;
  return `<div class="d ${good ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${d > 0 ? '+' : ''}${d.toFixed(digits)} ${unit} vs before</div>`;
}

function renderPerf() {
  const { before, after, label } = currentPerf();
  const cur = after || before;
  const el = $('#sec-perf');
  if (!cur) {
    el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[01]</b>performance</h2></div>
      <div class="empty">No measurements yet. Click MEASURE, or RUN WORKFLOW (measures before and after).</div>`;
    return;
  }
  const b = before || {};
  const runs = S.detail.runs.filter((r) => r.mem_after != null || r.mem_before != null).slice().reverse();
  el.innerHTML = `
    <div class="panel-head"><h2 class="panel-title"><b>[01]</b>performance</h2><span class="hint">${esc(label)}${before && after ? ' · before → after' : ''}</span></div>
    <div class="kpis">
      <div class="kpi hero"><div class="k">RAM available</div><div class="v">${fmtMB(cur.mem_available_mb)}<small>/ ${fmtMB(cur.mem_total_mb)} MB</small></div>${delta(b.mem_available_mb, after?.mem_available_mb, 'MB')}</div>
      <div class="kpi"><div class="k">swap used</div><div class="v">${fmtMB(cur.swap_used_mb)}<small>MB</small></div>${delta(b.swap_used_mb, after?.swap_used_mb, 'MB', false)}</div>
      <div class="kpi"><div class="k">load · 1 min</div><div class="v">${cur.load1 ?? '–'}</div>${delta(b.load1, after?.load1, '', false, 2)}</div>
      <div class="kpi"><div class="k">processes</div><div class="v">${cur.processes ?? '–'}</div>${delta(b.processes, after?.processes, '', false)}</div>
      <div class="kpi"><div class="k">packages off</div><div class="v">${cur.packages?.disabled ?? '–'}<small>/ ${cur.packages?.total ?? '–'}</small></div>${delta(b.packages?.disabled, after?.packages?.disabled, '', true)}</div>
      <div class="kpi"><div class="k">storage free</div><div class="v">${cur.storage_free_gb ?? '–'}<small>GB</small></div>${delta(b.storage_free_gb, after?.storage_free_gb, 'GB', true, 1)}</div>
    </div>
    <div class="grid-2">
      <div>
        <p class="chart-title">RAM available, before vs after (MB, of ${fmtMB(cur.mem_total_mb)} MB)</p>
        ${before && after ? compareChart(before, after) : `<div class="empty">Needs a run with before/after measurement. RUN WORKFLOW measures both.</div>`}
        <p class="chart-title" style="margin-top:18px">RAM available after each run (MB)</p>
        ${historyChart(runs, cur.mem_total_mb)}
      </div>
      <div>
        <p class="chart-title">Top memory users ${after ? 'now' : ''} (MB, PSS)</p>
        ${topChart(cur.top || [])}
      </div>
    </div>`;
}

/* charts: thin bars with 4px rounded data-ends anchored at the baseline, recessive grid, direct labels, hover tips */

function barPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  r = Math.min(r, w, h / 2);
  return `M${x},${y}h${w - r}q${r},0 ${r},${r}v${h - 2 * r}q0,${r} ${-r},${r}h${-(w - r)}z`;
}

function compareChart(before, after) {
  const W = 560, L = 70, R = 70, total = after.mem_total_mb || before.mem_total_mb || Math.max(before.mem_available_mb, after.mem_available_mb);
  const x = (v) => L + (v / total) * (W - L - R);
  const rows = [
    { k: 'before', v: before.mem_available_mb, c: 'var(--series-before)', t: before.time },
    { k: 'after', v: after.mem_available_mb, c: 'var(--series-after)', t: after.time },
  ];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(total * f));
  return `<svg class="chart" viewBox="0 0 ${W} 104" role="img" aria-label="RAM available before ${before.mem_available_mb} MB, after ${after.mem_available_mb} MB">
    ${ticks.map((t) => `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="6" y2="84"/><text class="axis-label" x="${x(t)}" y="100" text-anchor="middle">${t}</text>`).join('')}
    <line class="baseline" x1="${L}" x2="${L}" y1="4" y2="86"/>
    ${rows.map((r, i) => {
      const y = 14 + i * 36;
      return `<text x="${L - 10}" y="${y + 15}" text-anchor="end">${r.k}</text>
        <path class="mark" d="${barPath(L, y, x(r.v) - L, 22)}" fill="${r.c}"/>
        <text class="value" x="${x(r.v) + 8}" y="${y + 15}">${fmtMB(r.v)} MB</text>
        <rect class="hit" x="${L}" y="${y - 4}" width="${W - L}" height="30" data-tip="<b>${r.k}</b> · ${fmtMB(r.v)} MB available<br>${esc(date(r.t))}"/>`;
    }).join('')}
  </svg>`;
}

function topChart(top) {
  if (!top.length) return '<div class="empty">No process data.</div>';
  const W = 560, L = 230, R = 60, rowH = 22, max = Math.max(...top.map((p) => p.mb));
  const x = (v) => L + (v / max) * (W - L - R);
  const short = (n) => (n.length > 32 ? '…' + n.slice(-31) : n);
  return `<svg class="chart" viewBox="0 0 ${W} ${top.length * rowH + 8}" role="img" aria-label="Top memory users">
    <line class="baseline" x1="${L}" x2="${L}" y1="0" y2="${top.length * rowH}"/>
    ${top.map((p, i) => {
      const y = 4 + i * rowH;
      return `<text x="${L - 8}" y="${y + 11}" text-anchor="end">${esc(short(p.name))}</text>
        <path class="mark" d="${barPath(L, y + 2, Math.max(1, x(p.mb) - L), 12)}" fill="var(--series-after)"/>
        <text x="${x(p.mb) + 6}" y="${y + 12}" class="value">${p.mb}</text>
        <rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}" data-tip="<b>${esc(p.name)}</b><br>${p.mb} MB"/>`;
    }).join('')}
  </svg>`;
}

function historyChart(runs, total) {
  const pts = runs.map((r) => ({ v: r.mem_after ?? r.mem_before, r })).filter((p) => p.v != null);
  if (!pts.length) return '<div class="empty">No measured runs yet.</div>';
  const W = 560, H = 150, L = 46, R = 16, T = 10, B = 26;
  const max = Math.max(total || 0, ...pts.map((p) => p.v));
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i / (pts.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.v)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RAM available per run">
    ${ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join('')}
    ${pts.length > 1 ? `<path d="${line}" fill="none" stroke="var(--series-after)" stroke-width="2"/>` : ''}
    ${pts.map((p, i) => `<circle class="mark" cx="${x(i)}" cy="${y(p.v)}" r="4.5" fill="var(--series-after)" stroke="var(--surface)" stroke-width="2"/>
      <circle class="hit" cx="${x(i)}" cy="${y(p.v)}" r="12" data-tip="<b>${fmtMB(p.v)} MB</b> available<br>${esc(p.r.mode)} · ${esc(date(p.r.started))}${p.r.note ? '<br>' + esc(p.r.note) : ''}"/>
      ${i === 0 || i === pts.length - 1 ? `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="${pts.length === 1 ? 'middle' : i === 0 ? 'start' : 'end'}">${esc(date(p.r.started))}</text>` : ''}`).join('')}
    ${pts.length ? `<text class="value" x="${x(pts.length - 1) - 8}" y="${y(pts[pts.length - 1].v) - 10}" text-anchor="end">${fmtMB(pts[pts.length - 1].v)}</text>` : ''}
  </svg>`;
}

/* ------------------------------------------------------------------ pipeline */

const PHASES = {
  apply: ['connect', 'measure-before', 'apply', 'reboot', 'measure-after', 'verify'],
  plan: ['connect', 'plan', 'verify'],
  verify: ['connect', 'measure-before', 'reboot', 'measure-after', 'verify'],
  restore: ['connect', 'measure-before', 'restore', 'measure-after', 'verify'],
  revert: ['connect', 'measure-before', 'revert', 'measure-after', 'verify'],
  app: ['connect', 'app', 'verify'],
};
const PHASE_LABEL = { connect: 'connect', 'measure-before': 'measure ▸ before', apply: 'apply', plan: 'plan', reboot: 'reboot', 'measure-after': 'measure ▸ after', verify: 'verify', restore: 'restore', revert: 'revert', app: 'install / uninstall' };

function pipelineSource() {
  if (S.viewRun) {
    const r = S.viewRun;
    const phases = Object.fromEntries((r.phases || []).map((p) => [p.name, p]));
    return { mode: r.mode, phases, rounds: r.rounds || [], state: r.outcome, run: r.id, source: r.source, steps: r.steps, historic: true };
  }
  const L = S.live[S.selected];
  if (L && L.run) return { mode: L.mode, phases: L.phases, rounds: L.rounds, state: L.state, run: L.run, source: L.source, steps: L.steps };
  return null;
}

function renderPipeline() {
  const el = $('#sec-pipeline');
  const src = pipelineSource();
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[02]</b>workflow</h2>
    <span class="row">${src ? `<span class="hint">${src.historic ? 'viewing' : 'live'} run ${esc(src.run)} · ${esc(src.mode)} · ${src.source === 'cli' ? 'terminal' : 'dashboard'}</span> ${st(src.state === 'running' ? 'running' : src.state)}` : ''}
    ${src?.historic ? '<button class="btn btn-sm" data-action="back-live">BACK TO LIVE</button>' : ''}</span></div>`;
  if (!src) {
    el.innerHTML = head + `<div class="empty">No run in this session. RUN WORKFLOW lets you pick the steps (full revamp, apps only, cleanup, home screen…), then measures, applies step by step, pauses when it needs you and re-measures. PREVIEW is a dry run.</div>`;
    return;
  }
  const order = PHASES[src.mode] || Object.keys(src.phases);
  const L = S.live[S.selected];
  const waitingNow = !src.historic && ((busyState().job || {}).waiting || (busyState().job || {}).confirm || (L && L.state === 'running' && L.waiting));
  const steps = order.map((name, i) => {
    let p = src.phases[name];
    let status = p ? p.status : (src.state === 'running' ? 'pending' : 'skipped');
    if (status === 'running' && waitingNow && ['apply', 'restore', 'revert', 'app'].includes(name)) status = 'waiting';
    return `<div class="step ${status}"><div class="n">${String(i + 1).padStart(2, '0')}</div><div class="t">${esc(PHASE_LABEL[name] || name)}</div>
      <div class="s">${st(status)}${status === 'error' ? ' ' + explainBtn(`The "${name}" phase of a ${src.mode} run on ${S.selected} failed: ${p?.detail || 'no detail'}. What went wrong and what should I do?`) : ''}</div>${p?.detail ? `<div class="hint">${esc(p.detail)}</div>` : ''}</div>`;
  }).join('');
  const rounds = (src.rounds || []).filter(Boolean);
  const body = rounds.length ? rounds.map((acts, n) => {
    const shown = acts.filter((a) => a.status !== 'skipped');
    const counts = {};
    acts.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
    return `<div><div class="round-head"><span>${src.mode === 'plan' ? 'PLAN' : `ROUND ${n + 1}`} · ${acts.length} ACTION(S)</span>
      <span>${Object.entries(counts).map(([k, v]) => `${v} ${STATUS[k]?.[1] || k}`).join(' · ')}</span></div>
      ${shown.length ? `<div class="table-wrap" style="max-height:340px"><table class="t"><thead><tr><th>status</th><th>step</th><th>action</th><th>target</th><th>detail</th></tr></thead><tbody>
      ${shown.map((a) => `<tr><td>${st(a.status)}</td><td>${esc(a.step)}</td><td>${esc(a.action)}</td><td class="pkg-name">${esc(a.target)}</td><td class="pkg-note">${esc(a.detail)} ${explainBtn(`Explain this workflow step on ${S.selected}: [${a.status}] ${a.step} · ${a.action} · ${a.target} · ${a.detail}. Why does it happen, and do I need to do anything?`)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">✓ nothing to change: the TV matches the profile</div>'}</div>`;
  }).join('') : '<div class="empty">Waiting for the plan…</div>';
  const chosen = src.steps && src.steps.length < Object.keys(S.meta?.steps || {}).length
    ? `<div class="chips" style="margin:-6px 0 12px">${src.steps.map((x) => `<span class="chip accent">${esc(x)}</span>`).join('')}<span class="hint">steps in this run</span></div>` : '';
  el.innerHTML = head + chosen + `<div class="stepper">${steps}</div><div class="rounds">${body}</div>`;
}

/* ------------------------------------------------------------------ console */

function renderConsole() {
  const el = $('#console');
  if (!el) return;
  const L = S.live[S.selected];
  const lines = L ? L.log : [];
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = lines.length
    ? lines.map((l) => `<div class="ln lv-${l.level}"><span class="ts">${esc(time(l.t))}</span>${esc(l.text)}${l.level === 'error' || l.level === 'warn' ? ' ' + explainBtn(`Explain this ${l.level === 'error' ? 'error' : 'warning'} from ${S.selected}: ${l.text}`) : ''}</div>`).join('')
    : '<div class="ln lv-dim">$ waiting for events… (runs from the dashboard or the terminal stream here)</div>';
  if (stick) el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------------ apps */

const CLASS_ORDER = { user: 0, optional: 1, bloat: 2, unknown: 3, core: 4 };
const TABS = [
  ['changes', 'will change'], ['all', 'all'], ['bloat', 'bloat'], ['optional', 'optional'], ['user', 'user apps'],
  ['live-tv', 'live tv'], ['core', 'core'], ['unknown', 'unknown'],
];
function tabMatch(r, tab) {
  if (tab === 'all') return true;
  if (tab === 'changes') return !!r.effect;
  if (tab === 'live-tv') return r.locked === 'live-tv';
  return r.class === tab;
}

function decisionCell(r) {
  if (r.locked) {
    const why = { core: '🔒 core', 'live-tv': '🔒 live TV', catalog: '📦 installed by profile', unknown: '? unclassified' }[r.locked];
    return `<span class="lock" title="${r.locked === 'unknown' ? 'Classify it in a preset first (prompts/classify-packages.md)' : 'Protected'}">${why}</span>`;
  }
  const userApps = S.detail.profile.apps.user_apps || 'keep-others';
  const autoLabel = r.user ? (userApps === 'remove-others' ? 'auto · uninstall' : 'auto · keep')
    : r.class === 'bloat' ? 'auto · disable' : 'auto · leave';
  const opts = r.user ? [['auto', autoLabel], ['keep', 'keep'], ['uninstall', 'uninstall']]
    : [['auto', autoLabel], ['keep', 'keep on'], ['disable', 'disable']];
  return `<select class="decision" data-pkg="${esc(r.package)}" aria-label="Decision for ${esc(r.package)}">
    ${opts.map(([v, l]) => `<option value="${v}" ${r.decision === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function renderApps() {
  const el = $('#sec-apps');
  if (!el) return;
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[04]</b>all packages · keep / remove</h2>
    <span class="row"><button class="btn btn-sm" data-action="apps-reload" ${S.appsLoading ? 'disabled' : ''}>${S.appsLoading ? '<span class="spin">◌</span> loading' : '↻ RELOAD'}</button>
    <button class="btn btn-sm" data-action="apps-mem" ${S.appsLoading ? 'disabled' : ''}>MEASURE RAM PER APP</button></span></div>`;
  if (S.appsError && !S.apps) { el.innerHTML = head + `<div class="empty">${esc(S.appsError)}</div>`; return; }
  if (!S.apps) { el.innerHTML = head + `<div class="empty"><span class="spin">◌</span> reading packages from the TV and planning…</div>`; return; }
  const counts = Object.fromEntries(TABS.map(([k]) => [k, S.apps.filter((r) => tabMatch(r, k)).length]));
  const q = S.appsQuery.toLowerCase();
  const rows = S.apps.filter((r) => tabMatch(r, S.appsFilter) && (!q || (r.package + ' ' + r.note).toLowerCase().includes(q)))
    .sort((a, b) => (b.pss_mb || 0) - (a.pss_mb || 0) || (CLASS_ORDER[a.class] ?? 9) - (CLASS_ORDER[b.class] ?? 9)
      || a.package.localeCompare(b.package));
  el.innerHTML = head + `
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.appsFilter === k}" data-action="apps-tab" data-tab="${k}">${l}<span class="c">${counts[k]}</span></button>`).join('')}</div>
      <input class="search" type="search" placeholder="filter packages…" value="${esc(S.appsQuery)}" data-action="apps-search" aria-label="Filter packages">
    </div>
    <div class="table-wrap"><table class="t"><thead><tr><th>state</th><th>package</th><th>class</th>${S.appsMem ? '<th>RAM</th>' : ''}<th>decision</th><th>next run</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="${r.enabled ? 'state-on' : 'state-off'}">${r.enabled ? '● on' : '○ off'}</td>
      <td><div class="pkg-name">${esc(r.package)} ${explainBtn(`Explain the package ${r.package} on ${S.selected}: class ${r.class}, currently ${r.enabled ? 'on' : 'off'}, decision ${r.decision}${r.locked ? ' (locked: ' + r.locked + ')' : ''}, note "${r.note || ''}", next run: ${r.effect || 'no change'}. What is it, and should I keep or disable it?`)}</div>${r.note ? `<div class="pkg-note">${esc(r.note)}</div>` : ''}</td>
      <td><span class="cls cls-${esc(r.class)}">${esc(r.class)}</span></td>
      ${S.appsMem ? `<td class="mono">${r.pss_mb ? r.pss_mb + ' MB' : ''}</td>` : ''}
      <td>${decisionCell(r)}</td>
      <td>${r.effect ? `<span class="effect">→ ${esc(r.effect)}</span>` : '<span class="hint">—</span>'}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">nothing here</td></tr>`}
    </tbody></table></div>
    <div class="hint" style="margin-top:8px">Decisions are saved to the profile. "next run" is what RUN WORKFLOW will do. Core, live-TV and unclassified packages are locked.</div>`;
}

/* ------------------------------------------------------------------ history + danger */

function renderHistory() {
  const el = $('#sec-history');
  if (!el) return;
  const runs = S.detail.runs;
  el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[07]</b>run history</h2><span class="hint">${runs.length} run(s) · click to inspect</span></div>
    ${runs.length ? `<div class="table-wrap" style="max-height:320px"><table class="t"><thead><tr><th>when</th><th>mode</th><th>from</th><th>outcome</th><th>changes</th><th>RAM before → after</th><th></th></tr></thead><tbody>
    ${runs.map((r) => {
      const d = r.mem_before != null && r.mem_after != null ? r.mem_after - r.mem_before : null;
      return `<tr class="clickable" data-action="view-run" data-run="${esc(r.id)}" tabindex="0">
        <td>${esc(date(r.started))}</td><td>${esc(r.mode)}</td><td>${esc(r.source === 'cli' ? 'terminal' : r.source || '')}</td>
        <td>${st(r.outcome)}${r.outcome === 'error' ? ' ' + explainBtn(`Run ${r.id} (${r.mode}) on ${S.selected} ended with an error. What went wrong and what should I do?`) : ''}</td>
        <td class="mono">${r.summary?.changed ?? '–'}${r.summary?.disabled ? ` · ${r.summary.disabled} disabled` : ''}${r.summary?.uninstalled ? ` · ${r.summary.uninstalled} removed` : ''}</td>
        <td class="mono">${fmtMB(r.mem_before)} → ${fmtMB(r.mem_after)} MB ${d != null ? `<span class="${d >= 0 ? 'delta-up' : 'delta-down'}">(${d >= 0 ? '▲ +' : '▼ '}${d})</span>` : ''}${r.note ? `<div class="pkg-note">${esc(r.note)}</div>` : ''}</td>
        <td style="text-align:right">${r.summary?.changed > 0 && r.source !== 'manual' && ['apply', 'restore', 'revert'].includes(r.mode)
          ? `<button class="btn btn-sm" data-action="revert" data-run="${esc(r.id)}" ${busyState().running || !onlineOf(S.selected) ? 'disabled' : ''}>⟲ REVERT</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No runs yet.</div>'}`;
}

function renderDanger() {
  const el = $('#sec-danger');
  if (!el) return;
  const restore = S.detail.runs.find((r) => r.mode === 'restore');
  const reinstall = restore?.summary?.reinstall || [];
  el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[08]</b>danger zone</h2></div>
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="max-width:620px">
        <div style="font-weight:700">Restore this TV to its defaults</div>
        <div class="hint">Re-enables every disabled package, puts back the stock home screen, the original screensaver and animation speed.
        Apps that were uninstalled are listed for reinstalling from the Play Store. The profile stays as it is, so the next RUN WORKFLOW applies it again.</div>
      </div>
      <button class="btn btn-danger" data-action="restore" ${busyState().running || !onlineOf(S.selected) ? 'disabled' : ''}>⟲ RESTORE DEFAULTS</button>
    </div>
    ${reinstall.length ? `<div style="margin-top:14px"><div class="hint">Uninstalled since the baseline (from the last restore):</div>
      <div class="table-wrap" style="max-height:220px;margin-top:6px"><table class="t"><tbody>${reinstall.map((p) => `<tr><td class="pkg-name">${esc(p)}</td>
      <td style="text-align:right"><button class="btn btn-sm" data-action="open-play" data-pkg="${esc(p)}">OPEN IN PLAY STORE ON TV</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}

/* ------------------------------------------------------------------ prepare: TV data + walkthrough */

async function loadPrep(build = true) {
  if (!S.selected) return;
  const name = S.selected;
  S.prep.loading = !S.prep.data; S.prep.error = null; renderPrep();
  try {
    const d = await api(`/api/tv/${name}/prepare${build && onlineOf(name) ? '' : '?build=0'}`);
    if (name !== S.selected) return;
    S.prep.data = d;
  } catch (e) { S.prep.error = e.message; }
  S.prep.loading = false;
  renderPrep();
}

const DONE_STATES = ['done', 'verified', 'skipped'];
function prepProgress(g) {
  const steps = g?.steps || [];
  const done = steps.filter((x) => DONE_STATES.includes(x.status)).length;
  const reqLeft = steps.filter((x) => x.required && !['done', 'verified'].includes(x.status)).length;
  return { done, total: steps.length, reqLeft };
}

function stepStatus(stt) {
  return { verified: '<span class="st st-done">✓ verified</span>', done: '<span class="st st-done">✓ done</span>',
    skipped: '<span class="st st-skipped">– skipped</span>', todo: '<span class="st st-pending">○ to do</span>' }[stt] || esc(stt);
}

function renderPrep() {
  const el = $('#sec-prep');
  if (!el) return;
  const P = S.prep, d = P.data?.dossier, g = P.data?.guide;
  const busy = busyState().running, on = onlineOf(S.selected);
  const prog = prepProgress(g);
  const ready = g && prog.reqLeft === 0 && prog.done === prog.total;
  const show = P.show ?? !ready;
  const research = g?.research;
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[P]</b>prepare this TV</h2>
    <span class="row">${g ? `<span class="chip ${ready ? 'accent' : ''}">${ready ? '✓ prepared' : `${prog.done}/${prog.total} steps${prog.reqLeft ? ` · ${prog.reqLeft} required left` : ''}`}</span>` : ''}
    <button class="btn btn-sm" data-action="prep-toggle">${show ? 'HIDE' : 'SHOW'}</button></span></div>`;
  if (!show) { el.innerHTML = head; return; }
  if (P.loading) { el.innerHTML = head + '<div class="empty"><span class="spin">◌</span> reading everything from the TV…</div>'; return; }
  if (P.error && !d) { el.innerHTML = head + `<div class="empty">${esc(P.error)}</div>`; return; }
  if (!d) { el.innerHTML = head + `<div class="empty">No TV data yet${on ? '' : ' (TV offline)'}.</div>`; return; }
  const lt = d.live_tv || {};
  const facts = d.platform && d.platform !== 'adb' ? [
    ['TV', [d.brand, d.model || d.name].filter(Boolean).filter((x, i, a) => !a.some((y, j) => j !== i && y.toLowerCase().includes(x.toLowerCase()))).join(' ') || '?', d.name || ''],
    ['Platform', d.platform_label || d.platform, 'no Android, no developer mode'],
    ['Network', (d.network || []).map((n) => n.ip).join(', '), `open ports ${(d.ports || []).join(', ') || '?'}`],
    [d.platform === 'tizen' ? 'Apps' : d.platform === 'roku' ? 'Channels' : 'Apps (DIAL)', (d.apps || []).map((a) => a.name).join(', ') || 'none found', (d.apps || []).filter((a) => a.state === 'running').map((a) => a.name + ' running').join(', ')],
    ['Can do here', (d.capabilities_text || []).length + ' thing(s)', (d.capabilities_text || []).join(' · ')],
    ['UPnP', (d.upnp || []).map((u) => u.friendly_name).filter(Boolean).join(', ') || '–', (d.upnp || []).map((u) => u.description || u.manufacturer).filter(Boolean).join(' · ')],
    ['Read', ago(d.taken), (d.presets || []).join(', ')],
  ] : [
    ['TV', `${d.brand || ''} ${d.model || ''}`, d.props?.['ro.product.name']],
    ['System', `Android ${d.android}`, `patch ${d.security_patch || '?'} · fw ${d.firmware || '?'}`],
    ['Hardware', `${d.ram_mb} MB RAM · ${d.cpu_cores} cores`, `${d.soc || ''} · ${d.storage_free_gb}/${d.storage_total_gb} GB free`],
    ['Display', d.display || '?', `${d.locale || ''} · ${d.timezone || ''}`],
    ['Network', (d.network || []).map((n) => `${n.iface} ${n.ip}`).join(', ') || '?', `up ${d.uptime_h} h`],
    ['Play Store', d.play_store ? `yes · v${(d.play_store_version || '').split(' ')[0]}` : 'no', `${d.google_accounts} Google account(s)`],
    ['Live TV', lt.tuner_inputs?.length ? `tuner · ${lt.channels} channels` : 'no tuner', `${lt.external_inputs} external input(s)`],
    ['Remote', (d.remotes || []).join(', ') || '?', ''],
    ['Home screen', (d.home || '').split('/')[0], `${(d.launchers || []).length} launcher(s) installed`],
    ['Packages', `${d.packages?.total} total`, Object.entries(d.packages?.classes || {}).map(([k, v]) => `${v} ${k}`).join(' · ')],
    ['Presets', (d.presets || []).join(', '), `read ${ago(d.taken)}`],
  ];
  const steps = g?.steps || [];
  const openId = P.open ?? steps.find((x) => !DONE_STATES.includes(x.status))?.id;
  const stepHtml = (x, i) => {
    const open = x.id === openId;
    return `<div class="prep-step ${open ? 'open' : ''} ${DONE_STATES.includes(x.status) ? 'is-done' : ''}">
      <button class="prep-row" data-action="prep-open" data-step="${esc(x.id)}" aria-expanded="${open}">
        <span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t">${esc(x.title)}</span>
        ${x.required ? '<span class="chip">required</span>' : ''}<span class="sp"></span>${stepStatus(x.status)}</button>
      ${open ? `<div class="prep-body">
        ${x.why ? `<div class="body">${esc(x.why)}</div>` : ''}
        ${x.path?.length ? `<div class="crumbs">${x.path.map((c) => `<span>${esc(c)}</span>`).join('<i>›</i>')}</div>` : ''}
        ${x.how ? `<div class="how">${esc(x.how)}</div>` : ''}
        ${x.source ? `<div class="hint">source: ${/^https?:/.test(x.source) ? `<a href="${esc(x.source)}" target="_blank" rel="noopener">${esc(x.source)}</a>` : esc(x.source)}</div>` : ''}
        ${x.last_check ? `<div class="hint">last check: ${esc(x.last_check)} (${esc(ago(x.checked))})</div>` : ''}
        <div class="row" style="margin-top:10px">
          ${x.check ? `<button class="btn btn-sm btn-cyan" data-action="prep-step" data-op="verify" data-step="${esc(x.id)}" ${on ? '' : 'disabled'}>✓ VERIFY ON TV</button>` : ''}
          ${x.auto ? `<button class="btn btn-sm btn-primary" data-action="prep-step" data-op="auto" data-step="${esc(x.id)}" ${on ? '' : 'disabled'}>LET THE APP DO IT</button>` : ''}
          ${x.status === 'todo' ? `<button class="btn btn-sm" data-action="prep-step" data-op="done" data-step="${esc(x.id)}">I DID IT</button>
            <button class="btn btn-sm btn-ghost" data-action="prep-step" data-op="skip" data-step="${esc(x.id)}">SKIP</button>`
            : `<button class="btn btn-sm btn-ghost" data-action="prep-step" data-op="reset" data-step="${esc(x.id)}">MARK TO DO</button>`}
          ${explainBtn(`Preparation step "${x.title}" on ${S.selected} (${d.brand} ${d.model}): ${x.why || ''} Menu: ${(x.path || []).join(' > ')}. ${x.how || ''} Explain it and tell me exactly what to press.`)}
        </div></div>` : ''}
    </div>`;
  };
  el.innerHTML = head + `
    <div class="facts">${facts.map(([k, v, sub]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="hint">${esc(sub)}</div>` : ''}</div>`).join('')}</div>
    ${(d.notes || []).length ? `<ul class="notes">${d.notes.map((n) => `<li class="${n.level}">${n.level === 'warn' ? '⚠' : 'ℹ'} ${esc(n.text)}</li>`).join('')}</ul>` : ''}
    <div class="row" style="justify-content:space-between;margin:14px 0 8px">
      <div><b>Preparation guide</b> <span class="chip ${g?.source === 'agent' ? 'accent' : ''}">${g?.source === 'agent' ? '◆ researched by the agent' : 'built-in'}</span>
        <div class="hint">${esc(g?.summary || '')}${research && g?.source !== 'agent' ? ` · research requested ${esc(ago(research.requested))}, waiting for the agent` : ''}</div></div>
      <span class="row">
        <button class="btn btn-sm btn-cyan" data-action="prep-research" ${on && !busy ? '' : 'disabled'} title="The agent researches this exact model and writes model-specific steps">◆ RESEARCH THIS MODEL</button>
        <button class="btn btn-sm" data-action="prep-discover" ${on && !busy ? '' : 'disabled'}>↻ RE-READ TV DATA</button>
        <button class="btn btn-sm btn-ghost" data-action="prep-rebuild" ${on && !busy ? '' : 'disabled'} title="Back to the built-in steps from the presets">BUILT-IN STEPS</button>
      </span></div>
    <div class="prep-bar"><i style="width:${prog.total ? Math.round(100 * prog.done / prog.total) : 0}%"></i></div>
    <div class="prep-steps">${steps.map(stepHtml).join('')}</div>
    <div class="hint" style="margin-top:8px">${d.platform && d.platform !== 'adb' ? 'Do these with the TV remote and tick them off here. The agent can research the exact menus for this model.'
      : 'Steps marked required should be done before RUN WORKFLOW. The live screen below shows where you are on the TV.'}</div>`;
}

async function prepStep(op, id) {
  const g = await post(`/api/tv/${S.selected}/guide/${id}/${op}`);
  S.prep.data.guide = g;
  const st = g.steps.find((x) => x.id === id);
  if (op === 'verify' || op === 'auto') toast(st.status === 'verified' ? '✓ verified on the TV' : `not done yet (${st.last_check})`, st.status !== 'verified');
  if (DONE_STATES.includes(st.status)) S.prep.open = g.steps.find((x) => !DONE_STATES.includes(x.status))?.id ?? null;
  renderPrep();
}

/* ------------------------------------------------------------------ TVs without ADB */

function renderMainNet() {
  $('#main').innerHTML = `
    <section class="panel" id="sec-head"></section>
    <section class="panel" id="sec-prep"></section>
    <section class="panel" id="sec-screen"></section>
    <section class="panel" id="sec-dial"></section>
    <section class="panel" id="sec-tizen" ${S.detail.summary.platform === 'tizen' ? '' : 'hidden'}></section>
    <section class="panel" id="sec-pad" hidden></section>
    <section id="sec-agent"></section>`;
  renderHeadNet();
  renderTizen();
  renderPrep();
  renderScreen();
  renderDial();
}

function renderHeadNet() {
  const el = $('#sec-head');
  if (!el) return;
  const sum = S.detail.summary, on = onlineOf(sum.name);
  const caps = (S.dial?.caps || sum.caps || []).filter((c) => c !== 'keys?');
  const TEXT = { dial: 'start and stop YouTube / Netflix / Prime Video', 'roku-apps': 'list and launch channels', keys: 'remote keys over the network', guide: 'guided preparation',
    'tizen-apps': 'open and close installed apps', pair: 'remote keys after a one-time Allow on the TV', type: "typing into the TV's keyboard" };
  el.innerHTML = `<div class="tv-head"><div>
      <h1 class="tv-title"><span class="prompt">&gt;</span>${esc(sum.name)}</h1>
      <div class="tv-sub">${esc(sum.model)} · ${esc(sum.host)}</div>
      <div class="chips"><span class="online ${on ? 'on' : ''}">${on ? 'ONLINE' : 'OFFLINE'}</span>
        <span class="chip accent">${esc(sum.platform_label)}</span><span class="chip">no ADB</span></div></div></div>
    ${sum.platform === 'tizen' ? `<div class="alert" style="animation:none;margin-top:12px;padding:12px 14px">
      <b class="st st-manual">⚠ Samsung, not Android.</b> Samsung's own apps can't be removed and its Home button can't be replaced, and there are no screenshots
      (use the phone camera in [00]) or button remapping. <b>What works:</b> ${caps.map((c) => esc(TEXT[c] || c)).join(' · ')} · in Developer Mode: TizenTube (ad-free YouTube)
      and our own home screen the TV starts in, see [S].
      <div class="hint" style="margin-top:6px">For Kodi, SmartTube and the full workflow, add an Android / Google TV stick on HDMI with + ADD TV.</div></div>` : ''}
    <div class="alert" style="animation:none;margin-top:12px;padding:12px 14px" ${sum.platform === 'tizen' ? 'hidden' : ''}>
      <b class="st st-manual">⚠ Not an Android TV.</b> No developer mode exists on this TV, so debloating, installing apps, a new launcher,
      screenshots (use the phone camera in [00]) and button remapping are not possible here. <b>What works:</b> ${caps.map((c) => esc(TEXT[c] || c)).join(' · ') || 'recognition only'}.
      <div class="hint" style="margin-top:6px">For the full workflow, plug an Android / Google TV stick (Google TV Streamer, Chromecast with Google TV, Fire TV Stick)
      into HDMI and add it with + ADD TV. The TV stays the display and keeps its own live TV tuner.</div></div>`;
}

async function loadDial() {
  if (!S.selected || !onlineOf(S.selected)) { S.dial = { error: 'TV offline' }; renderDial(); return; }
  try { S.dial = await api(`/api/tv/${S.selected}/dial`); } catch (e) { S.dial = { error: e.message }; }
  renderDial(); renderHeadNet();
}

function renderDial() {
  const el = $('#sec-dial');
  if (!el) return;
  const D = S.dial;
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[A]</b>apps on the TV</h2><button class="btn btn-sm" data-action="dial-reload">↻</button></div>`;
  if (!D) { el.innerHTML = head + '<div class="empty"><span class="spin">◌</span> asking the TV…</div>'; return; }
  if (D.error) { el.innerHTML = head + `<div class="empty">${esc(D.error)}</div>`; return; }
  el.innerHTML = head + (D.apps.length ? `<div class="store-grid">${D.apps.map((a) => `<div class="store-card ${a.state === 'running' ? 'is-installed' : ''}">
      <b>${esc(a.name)}</b><div class="store-status">${a.state === 'running' ? '<span class="st st-done">● running now</span>' : `<span class="st st-pending">○ ${esc(a.state)}</span>`}</div>
      <div class="row" style="margin-top:8px"><button class="btn btn-sm btn-primary" data-action="dial-go" data-app="${esc(a.id)}" data-op="launch">▶ OPEN ON TV</button>
      ${a.state === 'running' ? `<button class="btn btn-sm" data-action="dial-go" data-app="${esc(a.id)}" data-op="stop">■ STOP</button>` : ''}</div></div>`).join('')}</div>`
    : '<div class="empty">The TV reports no DIAL apps.</div>')
    + (S.detail.summary.platform === 'tizen'
      ? '<div class="hint" style="margin-top:8px">Uses the TV\'s own network API. Only the well-known apps are listed; others open with the TV remote.</div>'
      : '<div class="hint" style="margin-top:8px">Uses DIAL, the protocol phones use to cast to the TV. Other apps can only be opened with the TV remote.</div>');
  const pad = $('#sec-pad');
  if (pad) {
    const caps = D.caps || [];
    pad.hidden = !(caps.includes('keys') || caps.includes('pair'));
    const head = '<div class="panel-head"><h2 class="panel-title"><b>[R]</b>remote</h2></div>';
    pad.innerHTML = caps.includes('pair')
      ? head + `<p class="hint">Pair once so this computer can send keys, open apps and type on the TV. Press PAIR, then choose <b>Allow</b> on the TV within 45 seconds.</p>
        <button class="btn btn-primary" data-action="pair-remote" ${S.pairing ? 'disabled' : ''}>${S.pairing ? '<span class="spin">◌</span> CHOOSE ALLOW ON THE TV…' : 'PAIR REMOTE'}</button>`
      : head + `<div class="pad">${[['power', '⏻'], ['home', '⌂'], ['back', '↩'], ['menu', '☰'], ['up', '▲'], ['volup', 'VOL+'], ['left', '◀'], ['ok', 'OK'], ['right', '▶'], ['mute', 'MUTE'], ['down', '▼'], ['voldown', 'VOL−']]
        .map(([k, l]) => `<button class="btn" data-action="key" data-key="${k}" aria-label="${k}">${l}</button>`).join('')}</div>`
        + (caps.includes('type') ? `<div class="row" style="margin-top:10px"><input class="search" id="type-text" maxlength="200" placeholder="text for the TV's on-screen keyboard…" aria-label="Text to type on the TV">
          <button class="btn btn-sm" data-action="type-send">TYPE ON TV</button></div>` : '');
  }
}

/* ------------------------------------------------------------------ Samsung: own apps in Developer Mode */

async function loadTizen() {
  const tv = S.selected;
  try { const st = await api(`/api/tv/${tv}/tizen`); if (tv === S.selected) S.tz = st; } catch (e) { S.tz = { error: e.message }; }
  renderTizen();
}

function handleTizenEvent(ev) {
  if (ev.tv !== S.selected) return;
  S.tzLog.push({ state: ev.state, line: ev.line });
  S.tzLog = S.tzLog.slice(-40);
  if (S.tz) S.tz.job = ev.state === 'running' ? ev.op : null;
  if (ev.state === 'owner' && /licen[cs]e/i.test(ev.line)) licenceModal();
  if (ev.state === 'done' && ev.op !== 'setup') toast(ev.op === 'install' ? `installed ${ev.result?.name || ''}` : 'removed');
  renderTizen();
  if (ev.state !== 'running') loadTizen();
}

function renderTizen() {
  const el = $('#sec-tizen');
  if (!el || el.hidden) return;
  const T = S.tz, busy = !!T?.job;
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[S]</b>own apps · developer mode</h2>
    <span class="row">${explainBtn('How does installing TizenTube and our own home screen on a Samsung TV work, and what does the owner have to do?')}
    <button class="btn btn-sm" data-action="tz-reload" ${busy ? 'disabled' : ''}>↻</button></span></div>`;
  if (!T) { el.innerHTML = head + '<div class="empty"><span class="spin">◌</span> checking tools and certificate…</div>'; return; }
  if (T.error) { el.innerHTML = head + `<div class="empty">${esc(T.error)}</div>`; return; }
  const left = T.checks.filter((c) => !c.ok);
  const checks = `<ol class="tz-checks">${T.checks.map((c) => `<li class="${c.ok ? 'ok' : ''}">
      <span class="st ${c.ok ? 'st-done' : c.owner ? 'st-manual' : 'st-pending'}">${c.ok ? '✓' : c.owner ? '⚠' : '○'}</span>
      <span><b>${esc(c.title)}</b>${c.ok ? '' : `<div class="hint">${esc(c.detail)}${c.owner ? ' · <b>you</b>' : ''}</div>`}</span></li>`).join('')}</ol>`;
  const setup = T.ready ? '<span class="st st-done">✓ ready to install apps</span>'
    : `<button class="btn btn-primary" data-action="tz-setup" ${busy ? 'disabled' : ''}>${busy && T.job === 'setup' ? '<span class="spin">◌</span> SETTING UP…' : '▶ SET UP'}</button>
       <span class="hint">does every step it can; stops where you need to act (${left.filter((c) => c.owner).length} for you)</span>`;
  const apps = Object.entries(T.apps).map(([id, a]) => `<div class="store-card ${a.installed ? 'is-installed' : ''}">
      <b>${esc(a.name)}</b> <span class="hint">${esc(a.version || '')}</span>
      <div class="store-status">${a.installed ? '<span class="st st-done">● installed</span>' : '<span class="st st-pending">○ not installed</span>'}</div>
      <div class="hint" style="margin:6px 0">${esc(a.note)}</div>
      <div class="row"><button class="btn btn-sm btn-primary" data-action="tz-install" data-app="${id}" ${!T.ready || busy ? 'disabled' : ''}>${a.installed ? '↻ REINSTALL' : '⤓ INSTALL'}</button>
        ${a.installed ? `<button class="btn btn-sm" data-action="tz-uninstall" data-app="${id}" ${busy ? 'disabled' : ''}>REMOVE</button>` : ''}
        ${id === 'override-home' ? `<a class="btn btn-sm" href="/samsung-home/${esc(S.selected)}/index.html" target="_blank" rel="noopener">PREVIEW</a>` : ''}</div></div>`).join('');
  const dock = new Set(T.dock || []);
  const dockEditor = `<details class="tz-dock"><summary>Home screen dock: ${(T.dock || []).length} app(s)</summary>
      <div class="hint">Shown in this order on Override Home; apps the TV doesn't have are skipped. Reinstall Override Home to apply.</div>
      <div class="tz-dock-list">${[...(T.dock || []).map((k) => T.dock_apps.find((a) => a.key === k)).filter(Boolean), ...T.dock_apps.filter((a) => !dock.has(a.key))]
        .map((a) => `<label class="check"><input type="checkbox" data-dock="${esc(a.key)}" ${dock.has(a.key) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</div>
      <button class="btn btn-sm" data-action="tz-dock-save">SAVE DOCK</button></details>`;
  const log = S.tzLog.length ? `<div class="console tz-log">${S.tzLog.map((l) => `<div class="${l.state === 'error' ? 'error' : l.state === 'owner' ? 'warn' : ''}">${l.state === 'owner' ? '⚠ ' : l.state === 'error' ? '✗ ' : '› '}${esc(l.line)}</div>`).join('')}</div>` : '';
  el.innerHTML = head + `<p class="hint">TizenTube (ad-free YouTube) and Override Home (our home screen) install in Samsung's Developer Mode, signed with a free
      Samsung certificate for this TV. The TV then starts in Override Home (see the Start Screen step in [P]); the Home button still opens Smart Hub.</p>
    ${checks}<div class="row" style="margin:10px 0">${setup}</div>${log}
    <div class="store-grid" style="margin-top:12px">${apps}</div>${dockEditor}`;
}

async function licenceModal() {
  let text = null;
  try { text = (await api(`/api/tv/${S.selected}/tizen/licence`)).text; } catch { /* shown below */ }
  modal(`<h2>Samsung Tizen SDK licence</h2>
    <p class="hint">Samsung's command-line tools are needed to sign and install apps on the TV. Installing them means accepting Samsung's licence. Read it, then accept or cancel.</p>
    <pre class="licence">${esc(text || 'The licence text could not be read.')}</pre>
    <label class="check"><input type="checkbox" id="tz-country-on"> Country for the certificate (optional): <input class="search" id="tz-country" maxlength="2" style="width:60px" placeholder="AL"></label>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-action="modal-close">CANCEL</button>
      <button class="btn btn-primary" data-action="tz-accept" ${text ? '' : 'disabled'}>I ACCEPT · INSTALL</button></div>`);
}

/* ------------------------------------------------------------------ live screen */

function renderScreen() {
  const el = $('#sec-screen');
  if (!el) return;
  const Sc = S.screen;
  el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[00]</b>live screen</h2>
    <span class="row" id="screen-controls"></span></div>
    <div class="screen-wrap ${Sc.big ? 'big' : ''}" data-action="screen-size" title="Click to enlarge / shrink">
      <img id="screen-img" alt="What the TV shows right now" ${Sc.url ? `src="${Sc.url}"` : ''}>
      <div class="screen-badge" id="screen-badge"></div>
      <div class="screen-msg" id="screen-msg"></div>
    </div>
    <div class="hint" id="screen-info" style="margin-top:6px"></div>${camBox()}`;
  renderScreenControls();
  renderScreenStatus();
  drawQr();
}

/* phone camera: a phone pointed at the TV replaces screenshots on TVs without ADB */
function camBox() {
  if (!isNet()) return '';
  const C = S.cam || {};
  if (!(C.running && C.tv === S.selected)) {
    return `<div class="cam-box"><div><b>This TV can't take screenshots.</b> A phone on the same Wi-Fi can be the camera: start it, open the link on the phone,
      accept the certificate warning (it is this computer's own certificate), tap START CAMERA and stand the phone facing the TV.
      ${C.running ? `<div class="hint">The camera is feeding ${esc(C.tv)} now; starting here switches it to this TV.</div>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-action="cam" data-on="1">START PHONE CAMERA</button></div></div></div>`;
  }
  return `<div class="cam-box"><div class="cam-qr" id="cam-qr" aria-label="QR code of the camera link"></div><div>
    <div>Open this on the phone (or scan the code):</div><a class="cam-url" href="${esc(C.url)}" target="_blank" rel="noopener">${esc(C.url)}</a>
    <div class="hint">${C.frames ? 'the phone is sending pictures' : 'waiting for the phone…'} · Safari: Show Details › visit this website ·
      stops by itself after 20 minutes without pictures</div>
    <div class="row" style="margin-top:8px"><button class="btn btn-sm" data-action="cam" data-on="0">■ STOP CAMERA</button></div></div></div>`;
}

function drawQr() {
  const el = $('#cam-qr'), url = S.cam?.url;
  if (!el || !url) return;
  const draw = () => { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
  if (window.qrcode) { draw(); return; }
  const tag = document.createElement('script');
  tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  tag.onload = () => { if ($('#cam-qr')) draw(); };
  tag.onerror = () => { el.hidden = true; };
  document.head.appendChild(tag);
}

async function loadCam() {
  try { S.cam = await api('/api/phonecam'); } catch { S.cam = null; }
  if (!isNet()) return;
  renderScreen();
  if (S.cam?.running && S.cam.tv === S.selected && S.cam.frames) setLive(true); else screenTick(true);
}

function handleCamEvent(ev) {
  const was = S.cam;
  S.cam = ev;
  if (!isNet() || !$('#sec-screen')) return;
  renderScreen();
  if (ev.running && ev.tv === S.selected && ev.frames && !(was?.frames && was.tv === ev.tv) && !S.screen.live) setLive(true);
  if (!ev.running && S.screen.live) setLive(false);
}

function renderScreenControls() {
  const el = $('#screen-controls');
  if (!el) return;
  const Sc = S.screen;
  el.innerHTML = `<button class="btn btn-sm ${Sc.live ? 'btn-primary' : ''}" data-action="screen-live" aria-pressed="${Sc.live}">${Sc.live ? '● LIVE' : '○ LIVE OFF'}</button>
    <select class="decision" id="screen-interval" aria-label="Refresh rate">${[[1000, 'every 1 s'], [2000, 'every 2 s'], [5000, 'every 5 s']].map(([v, l]) =>
      `<option value="${v}" ${Sc.interval === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn btn-sm" data-action="screen-now" ${Sc.busy ? 'disabled' : ''}>↻ NOW</button>
    <button class="btn btn-sm" data-action="screen-save" ${Sc.url ? '' : 'disabled'}>⤓ SAVE</button>
    <button class="btn btn-sm" data-action="screen-full">FULL SIZE</button>`;
}

function renderScreenStatus() {
  const Sc = S.screen;
  if ($('#screen-badge')) $('#screen-badge').innerHTML = Sc.live ? '<span class="busy">●</span> LIVE' : Sc.url ? 'STILL' : '';
  if ($('#screen-msg')) $('#screen-msg').textContent = Sc.error ? Sc.error : !Sc.url ? (Sc.busy ? 'capturing…' : 'no picture yet') : '';
  if ($('#screen-info')) $('#screen-info').textContent = Sc.info + (Sc.url && !isNet() ? ' · video apps can show black (copy protection)' : '');
}

async function screenTick(once = false) {
  const Sc = S.screen, tv = S.selected;
  clearTimeout(Sc.timer);
  if (!tv || !$('#screen-img')) return;
  const again = () => { if (Sc.live && !once) Sc.timer = setTimeout(() => screenTick(), Sc.interval); };
  if (document.hidden || Sc.busy) { again(); return; }
  if (!onlineOf(tv) && !isNet()) { Sc.error = 'TV offline'; renderScreenStatus(); again(); return; }
  Sc.busy = true; renderScreenStatus();
  try {
    const res = await fetch(`/api/tv/${tv}/screen?w=960`, { headers: { 'X-Token': window.TOKEN } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    if (tv !== S.selected) return;
    const old = Sc.url;
    Sc.url = URL.createObjectURL(blob);
    const img = $('#screen-img');
    if (img) img.src = Sc.url;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    Sc.error = null;
    const age = +res.headers.get('X-Age');
    Sc.info = res.headers.get('X-Capture-Ms') === 'phone'
      ? `phone camera · taken ${res.headers.get('X-Captured')}${age > 10 ? ` (${age < 120 ? age + ' s' : Math.round(age / 60) + ' min'} ago)` : ''}`
      : `captured ${res.headers.get('X-Captured')} · ${res.headers.get('X-Capture-Ms')} ms on the TV · ${Math.round(blob.size / 1024)} KB`;
  } catch (e) {
    Sc.error = e.message;
  } finally {
    Sc.busy = false;
    renderScreenStatus(); renderScreenControls();
    again();
  }
}

function setLive(on) {
  S.screen.live = on;
  renderScreenControls(); renderScreenStatus();
  if (on) screenTick(); else clearTimeout(S.screen.timer);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.screen.live) screenTick(); });

/* ------------------------------------------------------------------ app store */

function renderStore() {
  const el = $('#sec-store');
  if (!el) return;
  const St = S.store, busy = busyState().running;
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[03]</b>app store · install / uninstall single apps</h2>
    <span class="row"><label class="check" title="Installed apps are added to the profile, so every later run keeps them; uninstalled ones are removed from it">
      <input type="checkbox" data-opt="track" ${S.opts.track ? 'checked' : ''}> keep the profile in sync</label>
    <button class="btn btn-sm" data-action="store-reload">↻</button></span></div>`;
  if (S.storeError && !St) { el.innerHTML = head + `<div class="empty">${esc(S.storeError)}</div>`; return; }
  if (!St) { el.innerHTML = head + '<div class="empty"><span class="spin">◌</span> checking which apps are on the TV…</div>'; return; }
  const dis = busy ? 'disabled' : '';
  const card = (a) => {
    const update = a.installed && a.source === 'apk' && a.catalog_version && a.version && a.version !== a.catalog_version;
    return `<div class="store-card ${a.installed ? 'is-installed' : ''}">
      <div class="row" style="justify-content:space-between"><b>${esc(a.name)}</b>
        <span class="chip ${a.source === 'apk' ? 'accent' : ''}">${a.source === 'apk' ? '✓ verified APK' : 'Play Store'}</span></div>
      <div class="pkg-note">${esc(a.package)}</div>
      ${a.note ? `<div class="hint" style="margin-top:4px">${esc(a.note)}</div>` : ''}
      <div class="store-status">${a.installed ? `${st('done')} installed${a.version ? ` · v${esc(a.version)}` : ''}${a.enabled ? '' : ' · <span class="st st-manual">switched off</span>'}`
        : '<span class="st st-pending">○ not installed</span>'}${a.catalog_version ? ` <span class="hint">· catalog v${esc(a.catalog_version)}</span>` : ''}</div>
      <div class="chips">${a.in_profile ? '<span class="chip">in profile</span>' : ''}${a.roles.map((r) => `<span class="chip accent">${esc(r)}</span>`).join('')}
        ${a.needs_a11y ? '<span class="chip">needs accessibility switch</span>' : ''}</div>
      <div class="row" style="margin-top:10px">
        ${a.blocked && !a.installed ? '<span class="hint">no Play Store on this TV: needs a verified APK</span>' : ''}
        ${!a.installed && !a.blocked ? `<button class="btn btn-sm btn-primary" data-action="store-install" data-app="${esc(a.id)}" ${dis}>INSTALL</button>` : ''}
        ${update ? `<button class="btn btn-sm btn-cyan" data-action="store-update" data-app="${esc(a.id)}" ${dis}>UPDATE → v${esc(a.catalog_version)}</button>` : ''}
        ${a.installed ? `<button class="btn btn-sm" data-action="store-open" data-pkg="${esc(a.package)}">▶ OPEN</button>` : ''}
        ${a.installed && !a.roles.length ? `<button class="btn btn-sm btn-danger" data-action="store-uninstall" data-app="${esc(a.id)}" data-name="${esc(a.name)}" ${dis}>UNINSTALL</button>` : ''}
        ${a.installed && a.roles.length ? `<span class="lock" title="Change the profile's ${esc(a.roles.join(' / '))} first">🔒 in use</span>` : ''}
        ${explainBtn(`Explain the app ${a.name} (${a.package}) for ${S.selected}: what is it good for, and should I install it?`)}
      </div></div>`;
  };
  el.innerHTML = head + `
    <div class="hint" style="margin-bottom:10px">Installs one app on its own: no debloat and no launcher change needed.
      This TV's profile: debloat ${St.debloat ? '<b>on</b>' : '<b>off</b> (apps only)'} · home screen <b>${esc(St.launcher || 'stock')}</b>.</div>
    <div class="store-grid">${St.apps.map(card).join('')}</div>
    ${St.others.length ? `<div class="chart-title" style="margin-top:16px">Other apps installed on this TV</div>
    <div class="table-wrap" style="max-height:260px"><table class="t"><tbody>${St.others.map((o) => `<tr>
      <td><div class="pkg-name">${esc(o.package)} ${explainBtn(`Explain the app ${o.package} on ${S.selected}: what is it, and is it safe to uninstall?`)}</div>${o.note ? `<div class="pkg-note">${esc(o.note)}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" data-action="store-open" data-pkg="${esc(o.package)}">▶ OPEN</button>
      <button class="btn btn-sm btn-danger" data-action="store-uninstall" data-app="${esc(o.package)}" data-name="${esc(o.package)}" ${dis}>UNINSTALL</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="hint" style="margin-top:8px">Want an app that is not listed? Ask the agent to add it to the catalog (it verifies the APK against the official release first).</div>`;
}

async function appRun(appAction, appId) {
  await post(`/api/tv/${S.selected}/run`, { mode: 'app', app_action: appAction, app: appId, track: S.opts.track });
  S.viewRun = null;
  toast(`${appAction} started – follow it in the workflow panel`);
  await loadState(); renderLive(); renderStore();
}

function uninstallModal(app, name) {
  modal(`<h2>Uninstall ${esc(name)}?</h2>
    <p>This deletes the app and its data (logins, settings) from ${esc(S.selected)}. Preinstalled apps can't be deleted; they are switched off instead (reversible).</p>
    <p class="hint">${S.opts.track ? 'It is also removed from the profile, so later runs do not reinstall it.' : 'The profile is left as it is.'} You can undo this run from the run history (APK apps are reinstalled automatically, Play Store apps need a reinstall).</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-danger" data-action="store-uninstall-go" data-app="${esc(app)}">UNINSTALL</button></div>`);
}

/* ------------------------------------------------------------------ remote buttons */

const targetValue = (k) => (k.action ? `action:${k.package}/${k.action}` : `app:${k.open || k.package}`);
function targetFromValue(v) {
  if (v.startsWith('action:')) { const [pkg, ...act] = v.slice(7).split('/'); return { package: pkg, action: act.join('/') }; }
  return { open: v.slice(4) };
}

function renderKeys() {
  const el = $('#sec-keys');
  if (!el) return;
  const K = S.keys, C = S.capture;
  const listening = C.state === 'listening';
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[05]</b>remote buttons</h2>
    <span class="row"><button class="btn btn-sm btn-cyan" data-action="keys-learn" ${listening || !K ? 'disabled' : ''}>${listening ? '<span class="spin">◌</span> LISTENING' : '+ LEARN A BUTTON'}</button>
    <button class="btn btn-sm" data-action="keys-reload">↻</button></span></div>`;
  if (S.keysError && !K) { el.innerHTML = head + `<div class="empty">${esc(S.keysError)}</div>`; return; }
  if (!K) { el.innerHTML = head + '<div class="empty"><span class="spin">◌</span> reading buttons and apps from the TV…</div>'; return; }
  const r = K.remap;
  const profileKm = K.keys.map((k) => `${k.scan}=${k.action ? `action:${k.package}/${k.action}` : `app:${k.open}`}`).join(';');
  let status;
  if (!r.in_profile) status = `<div class="alert" style="animation:none;padding:10px 14px"><b class="st st-manual">⚠ Remote Remap is not in this TV's profile.</b> Mappings are saved but do nothing until <code>remote-remap</code> is added to <code>[apps].install</code> and the workflow runs.</div>`;
  else if (!r.installed) status = `<div class="alert" style="animation:none;padding:10px 14px"><b class="st st-manual">⚠ Remote Remap is not installed yet.</b> RUN WORKFLOW installs it; mappings saved here are pushed then.</div>`;
  else if (!r.enabled || !r.running) status = `<div class="alert" style="animation:none;padding:10px 14px"><b class="st st-manual">⚠ Remote Remap is ${r.enabled ? 'on but not running' : 'switched off'}.</b> On the TV: Settings → System → Accessibility → Remote Remap → ${r.enabled ? 'Off, then On' : 'On'}.</div>`;
  else status = `<div class="hint">${st('done')} Remote Remap is running · ${r.keymap === profileKm ? 'TV matches the profile' : '<span class="st st-manual">⚠ TV mapping differs from the profile: saving any button pushes it</span>'}</div>`;
  const capture = listening || C.presses.length ? `<div class="agent-card" style="margin:12px 0">
      <div class="who">${listening ? `◉ LISTENING · ${Math.max(0, Math.ceil((C.until - Date.now()) / 1000))}s` : '◎ CAPTURE FINISHED'}</div>
      <div class="body">${listening ? 'Press the button you want to remap on the remote. Press an arrow key first if the remote was asleep.' : 'Pick a button below, or listen again.'}</div>
      ${C.presses.length ? `<table class="t"><thead><tr><th>button</th><th>code</th><th>presses</th><th></th></tr></thead><tbody>
        ${C.presses.map((p) => `<tr><td>${esc(p.label || 'unknown button')}</td><td class="mono">${p.scan}</td><td class="mono">${p.count}</td><td style="text-align:right">
        ${p.protected ? '<span class="lock">🔒 needed for navigation</span>'
          : `<button class="btn btn-sm btn-cyan" data-action="key-map" data-scan="${p.scan}" data-label="${esc(p.label)}">${p.mapped ? 'CHANGE MAPPING' : 'MAP THIS BUTTON'}</button>`}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">no presses yet…</div>'}</div>` : '';
  el.innerHTML = head + status + capture + (K.keys.length ? `
    <div class="table-wrap" style="margin-top:10px"><table class="t"><thead><tr><th>button</th><th>code</th><th>opens</th><th></th></tr></thead><tbody>
    ${K.keys.map((k) => `<tr><td><b>${esc(k.label || K.remote_labels[k.scan] || 'button')}</b></td><td class="mono">${k.scan}</td>
      <td><div class="pkg-name">${esc(k.target_label)}</div><div class="pkg-note">${esc(k.action ? `${k.package} · ${k.action}` : k.open)}${k.missing ? ' · <span class="st st-error">✖ not on this TV</span>' : ''}</div></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" data-action="key-try" data-scan="${k.scan}">▶ TRY</button>
      <button class="btn btn-sm" data-action="key-edit" data-scan="${k.scan}">CHANGE</button>
      <button class="btn btn-sm btn-danger" data-action="key-remove" data-scan="${k.scan}">REMOVE</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No buttons remapped yet. Click + LEARN A BUTTON and press one on the remote.</div>')
    + '<div class="hint" style="margin-top:8px">Saving writes the [keys] table of the profile and pushes it to the TV straight away. TRY opens the target on the TV now.</div>';
}

function keyEditor(scan, label) {
  const K = S.keys;
  const cur = K.keys.find((k) => k.scan === +scan);
  const value = cur ? targetValue(cur) : '';
  const apps = K.targets.filter((t) => t.type === 'app'), acts = K.targets.filter((t) => t.type === 'action');
  const opt = (t) => { const v = t.type === 'action' ? `action:${t.package}/${t.action}` : `app:${t.package}`;
    return `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t.label)}${t.type === 'app' && t.label !== t.package ? ` (${esc(t.package)})` : ''}</option>`; };
  modal(`<h2>⌨ Button ${esc(scan)}${label ? ` · ${esc(label)}` : ''}</h2>
    <p>Choose what this button opens. The original function of the button (e.g. Netflix) is replaced.</p>
    <div class="field"><label for="key-label">name shown in the dashboard</label><input id="key-label" value="${esc(cur?.label || label || '')}" placeholder="e.g. Netflix"></div>
    <div class="field"><label for="key-target">opens</label><select id="key-target" class="decision" style="padding:8px">
      ${value ? '' : '<option value="" selected disabled>choose an app…</option>'}
      <optgroup label="Apps on this TV">${apps.map(opt).join('')}</optgroup>
      ${acts.length ? `<optgroup label="Actions">${acts.map(opt).join('')}</optgroup>` : ''}
    </select></div>
    <input type="hidden" id="key-scan" value="${esc(scan)}">
    <div class="row" style="justify-content:space-between;margin-top:14px">
      <button class="btn" data-action="key-try-modal">▶ TRY ON TV</button>
      <span class="row"><button class="btn" data-action="modal-close">CANCEL</button><button class="btn btn-primary" data-action="key-save">SAVE &amp; PUSH</button></span>
    </div>`);
}

/* ------------------------------------------------------------------ agent desk */

const relevant = (it) => !it.tv || it.tv === S.selected;
function openAsks(tv, strict = false) {
  return S.agent.items.filter((i) => i.type === 'ask' && i.status === 'open' && (strict ? i.tv === tv : !i.tv || i.tv === tv));
}

function renderAgentChip() {
  const el = $('#agent-chip');
  if (!el) return;
  const age = S.agent.seen ? (Date.now() - new Date(S.agent.seen)) / 1000 : Infinity;
  el.classList.toggle('on', age < 90);
  el.classList.toggle('idle', age >= 90);
  $('.lbl', el).textContent = age < 90 ? 'AGENT ONLINE' : S.agent.seen ? `AGENT IDLE · ${ago(S.agent.seen)}` : 'AGENT IDLE';
}

function askCard(it) {
  const opts = it.options || [];
  let input = '';
  if (it.kind === 'choice') input = `<ul class="opt-list">${opts.map((o, i) => `<li><label><input type="radio" name="ask-${it.id}" value="${i}" ${o.checked ? 'checked' : ''}>
      <span>${esc(o.label)}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</span></label></li>`).join('')}</ul>`;
  if (it.kind === 'multi') input = `<div class="row" style="margin-top:8px"><button class="btn btn-sm" data-action="ask-all" data-id="${it.id}">ALL</button>
      <button class="btn btn-sm" data-action="ask-none" data-id="${it.id}">NONE</button><span class="hint">${opts.length} option(s)</span></div>
      <ul class="opt-list">${opts.map((o, i) => `<li><label><input type="checkbox" data-ask="${it.id}" value="${i}" ${o.checked ? 'checked' : ''}>
      <span>${esc(o.label)}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</span></label></li>`).join('')}</ul>`;
  if (it.kind === 'text') input = `<textarea class="ta" id="ask-text-${it.id}" placeholder="type your answer…"></textarea>`;
  const buttons = it.kind === 'confirm'
    ? `<button class="btn btn-cyan" data-action="ask-yes" data-id="${it.id}">YES</button><button class="btn" data-action="ask-no" data-id="${it.id}">NO</button>`
    : it.kind === 'action'
      ? `<button class="btn btn-cyan" data-action="ask-send" data-id="${it.id}">✓ DONE</button>`
      : `<button class="btn btn-cyan" data-action="ask-send" data-id="${it.id}">SEND ANSWER</button>`;
  return `<div class="agent-card" role="alert" id="ask-${it.id}">
    <div class="who">◆ THE AGENT ASKS ${it.tv ? `<span class="chip">${esc(it.tv)}</span>` : ''}<span class="hint">${esc(ago(it.created))}</span></div>
    <h3>${esc(it.title)}</h3>${it.body ? `<div class="body">${esc(it.body)}</div>` : ''}
    ${input}<div class="row">${buttons}<button class="btn btn-sm btn-ghost" data-action="ask-chat" data-id="${it.id}" title="Skip this here and answer in the chat instead">ANSWER IN CHAT INSTEAD</button></div></div>`;
}

function feedItem(it) {
  const t = ago(it.created);
  if (it.type === 'note') {
    const icon = { info: 'ℹ', warn: '⚠', 'need-chat': '💬', done: '✓' }[it.level];
    return `<div class="feed-item from-agent"><div class="meta">AGENT · ${esc(it.level)} · ${esc(t)}${it.tv ? ' · ' + esc(it.tv) : ''}</div>${icon} <b>${esc(it.title)}</b>${it.body ? `<div class="pkg-note">${esc(it.body)}</div>` : ''}</div>`;
  }
  if (it.type === 'ask') {
    const ans = it.status === 'answered' ? (Array.isArray(it.answer) ? `${it.answer.length} selected` : typeof it.answer === 'boolean' ? (it.answer ? 'yes' : 'no') : String(it.answer)) : it.status;
    return `<div class="feed-item from-agent"><div class="meta">AGENT ASKED · ${esc(t)}</div>${esc(it.title)}<div class="pkg-note">→ you: ${esc(ans)}</div></div>`;
  }
  const status = { open: 'queued · the agent picks it up when it next checks in', taken: 'picked up by the agent', done: 'done' }[it.status] || it.status;
  return `<div class="feed-item from-you"><div class="meta">YOU → AGENT · ${esc(it.topic)} · ${esc(t)}</div>${esc(it.text || it.topic)}
    <div class="pkg-note">${esc(status)}</div>${it.reply ? `<div style="margin-top:4px"><span class="st st-running">◆</span> ${esc(it.reply)}</div>` : ''}</div>`;
}

const TOPICS = [
  ['classify', 'Classify unknown packages'], ['remote', 'Set up remote buttons'], ['apps', 'Change which apps I have'],
  ['broken', 'Something is broken'], ['message', 'Other'],
];

function renderAgent() {
  const el = $('#sec-agent');
  if (!el) return;
  const asks = S.agent.items.filter((i) => i.type === 'ask' && i.status === 'open' && relevant(i));
  const chats = S.agent.items.filter((i) => i.type === 'note' && i.level === 'need-chat' && i.status === 'open' && relevant(i));
  const feed = S.agent.items.filter((i) => relevant(i) && !(i.type === 'ask' && i.status === 'open')).slice(-12).reverse();
  // keep what the owner is typing / ticking while events re-render the panel
  const draft = $('#inbox-text')?.value || '';
  const typing = Object.fromEntries([...document.querySelectorAll('textarea[id^="ask-text-"]')].map((t) => [t.id, t.value]));
  const ticks = Object.fromEntries([...document.querySelectorAll('[data-ask]')].map((c) => [c.dataset.ask + ':' + c.value, c.checked]));
  const radios = Object.fromEntries([...document.querySelectorAll('input[type=radio][name^="ask-"]:checked')].map((r) => [r.name, r.value]));
  el.innerHTML = `
    ${chats.map((n) => `<div class="need-chat" role="alert"><div class="who">💬 THE AGENT NEEDS YOU IN THE CHAT</div>
      <h3 style="margin:6px 0 2px">${esc(n.title)}</h3>${n.body ? `<div class="body" style="white-space:pre-wrap;color:var(--text-2)">${esc(n.body)}</div>` : ''}
      <div class="row" style="margin-top:8px"><span class="hint">Go to your agent chat (Claude Code, Codex, …) to continue.</span><button class="btn btn-sm" data-action="note-dismiss" data-id="${n.id}">DISMISS</button></div></div>`).join('')}
    ${asks.map(askCard).join('')}
    <div class="panel">
      <div class="panel-head"><h2 class="panel-title"><b>[AI]</b>agent</h2><span class="hint">questions come here first; the chat is the fallback</span></div>
      <div class="grid-2">
        <div>
          <div class="chart-title">Ask the agent${S.selected ? ` about ${esc(S.selected)}` : ''}</div>
          <div class="topic-row">${TOPICS.map(([k, l]) => `<button class="tab" data-action="topic" data-topic="${k}" aria-selected="${S.topic === k}">${esc(l)}</button>`).join('')}</div>
          <textarea class="ta" id="inbox-text" placeholder="Describe what you want (optional for the quick topics)…">${esc(draft)}</textarea>
          <div class="row" style="margin-top:8px"><button class="btn btn-cyan" data-action="inbox-send">SEND TO AGENT</button>
          <span class="hint">The agent reads this the next time it checks in (it does between steps while working).</span></div>
        </div>
        <div><div class="chart-title">Conversation</div>
          <div class="feed">${feed.map(feedItem).join('') || '<div class="empty">Nothing yet.</div>'}</div></div>
      </div>
    </div>`;
  for (const [id, v] of Object.entries(typing)) { const t = document.getElementById(id); if (t) t.value = v; }
  for (const c of document.querySelectorAll('[data-ask]')) { const k = c.dataset.ask + ':' + c.value; if (k in ticks) c.checked = ticks[k]; }
  for (const [name, v] of Object.entries(radios)) { const r = document.querySelector(`input[name="${name}"][value="${v}"]`); if (r) r.checked = true; }
}

async function answerAsk(id, answer) {
  await post(`/api/ask/${id}/answer`, { answer });
  toast('answer sent to the agent');
}

/* ------------------------------------------------------------------ modals */

function modal(html) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const first = $('#modal-root input, #modal-root button');
  first && first.focus();
}
const closeModal = () => ($('#modal-root').innerHTML = '');

async function revertModal(runId) {
  modal(`<h2>⟲ Revert run ${esc(runId)}?</h2><p><span class="spin">◌</span> working out what that run changed…</p>`);
  let plan;
  try { plan = await api(`/api/tv/${S.selected}/runs/${runId}/revert-plan`); }
  catch (e) { modal(`<h2>⟲ Revert run ${esc(runId)}</h2><p class="st st-error">✖ ${esc(e.message)}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CLOSE</button></div>`); return; }
  const acts = plan.actions.filter((a) => a.status !== 'skipped');
  const skipped = plan.actions.filter((a) => a.status === 'skipped');
  modal(`<h2>⟲ Revert run ${esc(runId)}</h2>
    <p>This undoes what that run changed on ${esc(S.selected)}, newest change first. Apps it uninstalled have to be reinstalled from the Play Store (listed below).</p>
    ${acts.length ? `<div class="table-wrap" style="max-height:300px"><table class="t"><thead><tr><th></th><th>undo</th><th>target</th><th>detail</th></tr></thead><tbody>
      ${acts.map((a) => `<tr><td>${st(a.status === 'todo' ? 'todo' : a.status)}</td><td>${esc(a.action)}</td><td class="pkg-name">${esc(a.target)}</td><td class="pkg-note">${esc(a.detail)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nothing left to undo: the TV already looks like it did before that run.</div>'}
    ${skipped.length ? `<p class="hint">${skipped.length} change(s) can't be reverted exactly (their previous value wasn't recorded in older runs).</p>` : ''}
    <label class="check" style="margin-top:10px"><input type="checkbox" id="revert-keep" checked> also mark re-enabled apps as <b>keep</b> in the profile, so the next RUN WORKFLOW doesn't disable them again</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-warn" data-action="revert-go" data-run="${esc(runId)}" ${acts.length ? '' : 'disabled'}>⟲ REVERT</button></div>`);
}

function restoreModal() {
  modal(`<h2>⟲ Restore ${esc(S.selected)} to defaults?</h2>
    <p>Every disabled package comes back, the stock home screen returns, and screensaver/animations go back to how they were.
    This takes a minute; RAM use will go up again.</p>
    <div class="field"><label for="confirm-name">type the TV name to confirm</label><input id="confirm-name" autocomplete="off" placeholder="${esc(S.selected)}"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-danger" data-action="restore-go">RESTORE</button></div>`);
}

function addTvModal(found = null, scanning = false, nets = []) {
  const tvs = (found || []).filter((f) => f.tv), others = (found || []).filter((f) => !f.tv);
  const tvRow = (f) => {
    let action;
    if (f.moved_from) action = `<button class="btn btn-sm btn-primary" data-action="move-tv" data-tv="${esc(f.profile)}" data-host="${esc(f.host)}" data-port="${f.adb_port}">UPDATE ADDRESS of ${esc(f.profile)}</button>`;
    else if (f.profile) action = `<span class="hint">already added: ${esc(f.profile)}</span>`;
    else if (f.pairing) action = `<button class="btn btn-sm btn-cyan" data-action="pair-start" data-host="${esc(f.host)}" data-port="${f.adb_port}">PAIR</button>`;
    else if (f.adb_enabled) action = `<button class="btn btn-sm" data-action="pick-host" data-host="${esc(f.host)}" data-port="${f.adb_port}">USE</button>`;
    else if (f.platform && f.platform !== 'adb') action = `<button class="btn btn-sm" data-action="pick-host" data-host="${esc(f.host)}" data-port="5555" title="${esc((f.capabilities || []).join(' · '))}">ADD (limited)</button>`;
    else action = '<span class="hint">turn on USB or Wireless debugging first</span>';
    const adb = f.adb_enabled ? '<span class="st st-done">✓ ADB on</span>' : f.pairing ? '<span class="st st-manual">⚿ needs pairing</span>'
      : f.platform && f.platform !== 'adb' ? '<span class="st st-skipped">– not Android</span>' : '<span class="st st-manual">⚠ ADB off</span>';
    return `<tr><td class="mono">${esc(f.host)}${f.adb_port && f.adb_port !== 5555 ? ':' + f.adb_port : ''}</td><td>${esc(f.kind)}${f.capabilities ? `<div class="hint">${esc(f.capabilities.join(' · '))}</div>` : ''}</td><td>${esc([f.brand, f.name].filter(Boolean).join(' · '))}</td><td>${adb}</td>
      <td style="text-align:right">${action}${f.moved_from ? `<div class="hint">was ${esc(f.moved_from)}: the TV got a new address</div>` : ''}</td></tr>`;
  };
  modal(`<h2>+ Add a TV</h2>
    <p>On the TV: <b>Settings → System → About</b> → click <b>Build</b> 7× → back to <b>System → Developer options</b> → turn on <b>USB debugging</b>
      (or <b>Wireless debugging</b> on newer TVs). The TV must be switched on, not in standby.</p>
    <div class="row"><button class="btn" data-action="scan" ${scanning ? 'disabled' : ''}>${scanning ? '<span class="spin">◌</span> SCANNING (~20 s)…' : '⌕ SCAN NETWORK'}</button>
    ${nets.length ? `<span class="hint">scanned ${esc(nets.join(', '))} + mDNS</span>` : ''}</div>
    ${found ? (tvs.length ? `<div class="table-wrap" style="margin-top:10px;max-height:240px"><table class="t"><thead><tr><th>address</th><th>kind</th><th>name</th><th>adb</th><th></th></tr></thead><tbody>
      ${tvs.map(tvRow).join('')}</tbody></table></div>`
      : `<div class="alert" style="animation:none;margin-top:10px;padding:12px 14px"><b class="st st-manual">⚠ No TV answered.</b>
        <ul class="hint" style="margin:6px 0 0;padding-left:18px">
          <li>Is the TV fully on? Most TVs switch the network off in standby (TCL: turn on <i>Network standby</i>).</li>
          <li>Is it on this network, or one hop behind the router? Scanned: ${esc(nets.join(', '))}.</li>
          <li>Is <i>USB debugging</i> or <i>Wireless debugging</i> on? Without it the TV is only found if it announces Cast.</li>
          <li>Type the TV's IP below (TV: Settings → Network → status).</li></ul></div>`) : ''}
    ${others.length ? `<details style="margin-top:8px"><summary class="hint">${others.length} other device(s) on the network</summary>
      <table class="t"><tbody>${others.map((f) => `<tr><td class="mono">${esc(f.host)}</td><td>${esc(f.kind)}</td><td class="hint">ports ${esc(f.ports.join(', ') || 'none open')}</td>
      <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-action="pick-host" data-host="${esc(f.host)}" data-port="5555">TRY</button></td></tr>`).join('')}</tbody></table></details>` : ''}
    <div id="pair-box"></div>
    <div class="row">
      <div class="field" style="flex:2"><label for="new-host">TV IP address</label><input id="new-host" placeholder="192.168.1.50" autocomplete="off"></div>
      <div class="field" style="flex:1"><label for="new-port">ADB port</label><input id="new-port" value="5555" inputmode="numeric" autocomplete="off"></div>
    </div>
    <div class="field"><label for="new-name">name (room-brand)</label><input id="new-name" placeholder="kitchen-sony" autocomplete="off"></div>
    <p class="hint" id="init-status"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-primary" data-action="init">CONNECT &amp; CREATE PROFILE</button></div>`);
}

function pairBox(host, connectPort) {
  $('#pair-box').innerHTML = `<div class="agent-card" style="margin:10px 0">
    <div class="who">⚿ PAIR WITH ${esc(host)}</div>
    <div class="body">On the TV: <b>Developer options → Wireless debugging → Pair device with pairing code</b>. Type the 6-digit code and the port shown there (it is different from ${connectPort}).</div>
    <div class="row"><div class="field" style="flex:1"><label for="pair-port">pairing port</label><input id="pair-port" inputmode="numeric"></div>
    <div class="field" style="flex:1"><label for="pair-code">6-digit code</label><input id="pair-code" inputmode="numeric" maxlength="6"></div></div>
    <button class="btn btn-cyan" data-action="pair-go" data-host="${esc(host)}" data-port="${connectPort}">PAIR</button></div>`;
  $('#pair-port').focus();
}

/* ------------------------------------------------------------------ actions */

const STEP_TITLES = { apps: 'Apps', debloat: 'Debloat', home: 'Home screen', screensaver: 'Screensaver', tweaks: 'Speed tweaks', buttons: 'Remote buttons' };
const RECIPE_TITLES = { full: 'FULL REVAMP', 'apps-only': 'APPS ONLY', cleanup: 'CLEANUP ONLY', 'home-screen': 'HOME SCREEN ONLY' };

function lastRecipe() { try { return localStorage.getItem(`recipe:${S.selected}`) || 'full'; } catch { return 'full'; } }
function saveRecipe(r) { try { localStorage.setItem(`recipe:${S.selected}`, r); } catch { /* private mode */ } }

function runPicker() {
  const M = S.meta, prof = S.detail.profile, home = prof.home || {}, apps = prof.apps || {};
  const recipe = lastRecipe(), chosen = new Set(M.recipes[recipe] || M.recipes.full);
  const keys = Object.keys(prof.keys || {}).length;
  const installs = (apps.install || []).length;
  const sel = (id, opts, cur) => `<select class="decision" id="${id}" style="padding:5px 8px">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const detail = {
    apps: `${installs} app(s) in the profile: ${esc((apps.install || []).join(', ') || 'none')}. Other apps you installed: ${apps.user_apps === 'remove-others' ? '<b>removed</b> (asks first)' : 'left alone'}.`,
    debloat: apps.debloat === false ? 'This profile is <b>apps only</b>: only your own disable list is applied, preset bloat is left on.'
      : `Disables bloat and tracking from the presets plus ${(apps.disable || []).length} package(s) on your disable list. Reversible.`,
    home: `${sel('pick-launcher', [['', '— leave the home screen alone —'], ['stock', "The TV's own home screen"], ...M.launchers.map((l) => [l.id, l.name])], home.launcher)}
      <div class="hint" id="home-hint"></div>`,
    screensaver: sel('pick-screensaver', [['', '— leave as it is —'], ...M.screensavers.map((x) => [x.id, x.name])], home.screensaver),
    tweaks: `${sel('pick-anim', [['', 'Animations: leave as they are'], ['0.5', 'Animations: snappy (0.5×)'], ['1', 'Animations: normal (1×)'], ['0', 'Animations: off (0×)']], home.animation_scale ?? '')}
      ${sel('pick-dns', [['', 'DNS: leave as it is'], ...(M.dns_filters || []).map((f) => [f.id, `DNS ad filter: ${f.name}`]), ['off', 'DNS: no filter (automatic)']], home.dns)}
      <div class="hint" id="dns-hint"></div>`,
    buttons: keys ? `${keys} button(s) mapped. Installs Remote Remap if needed and pushes the map.` : 'No buttons mapped yet: map them in [05] remote buttons first.',
  };
  modal(`<h2>▶ Run workflow on ${esc(S.selected)}</h2>
    <div class="row" style="margin:8px 0 12px">${Object.keys(M.recipes).map((r) => `<button class="tab" data-action="recipe" data-recipe="${r}" aria-selected="${r === recipe}">${RECIPE_TITLES[r] || r}</button>`).join('')}
      <span class="hint">or tick the steps you want</span></div>
    <div class="steps-pick">${Object.entries(M.steps).map(([id, desc]) => `<label class="step-pick">
      <input type="checkbox" data-step="${id}" ${chosen.has(id) ? 'checked' : ''} ${id === 'buttons' && !keys ? 'disabled' : ''}>
      <span><b>${STEP_TITLES[id] || id}</b> <span class="hint">${esc(desc)}</span><div class="step-detail">${detail[id]}</div></span></label>`).join('')}</div>
    ${prepProgress(S.prep.data?.guide).reqLeft ? `<div class="alert" style="animation:none;padding:8px 12px;margin-top:10px"><span class="st st-manual">⚠ ${prepProgress(S.prep.data?.guide).reqLeft} required preparation step(s) not done yet</span> <span class="hint">(see [P] prepare this TV)</span></div>` : ''}
    <div class="hint" style="margin-top:8px">Live TV and HDMI inputs are always protected, and every run can be undone from the run history.</div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="pick-reboot" ${S.opts.reboot ? 'checked' : ''}> reboot after changes for an accurate after-measurement</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-action="modal-close">CANCEL</button>
      <button class="btn" data-action="picker-go" data-mode="plan">PREVIEW</button>
      <button class="btn btn-primary" data-action="picker-go" data-mode="apply">▶ RUN</button></div>`);
  updateHomeHint();
  updateDnsHint();
}

function updateDnsHint() {
  const v = $('#pick-dns')?.value, el = $('#dns-hint'), f = (S.meta.dns_filters || []).find((x) => x.id === v);
  if (!el) return;
  el.textContent = f ? `${f.about} Free, no account. Encrypted (Private DNS, Android 9+). After setting it the run checks the TV still has internet, and puts the old DNS back if not. Doesn't block YouTube ads (same servers as the video).`
    : v === 'off' ? "Back to Android's automatic DNS (the router's)." : '';
}

function updateHomeHint() {
  const v = $('#pick-launcher')?.value, el = $('#home-hint');
  if (!el) return;
  el.textContent = !v ? 'The home step does nothing until you pick one.'
    : v === 'stock' ? 'Brings back the original home screen if it was replaced.'
    : 'Installs it, waits for you to switch on its accessibility service, then switches off the original launcher and setup wizard (never one without the other).';
}

async function pickerGo(mode) {
  const steps = [...document.querySelectorAll('[data-step]')].filter((c) => c.checked).map((c) => c.dataset.step);
  if (!steps.length) { toast('tick at least one step', true); return; }
  const home = S.detail.profile.home || {}, changes = {};
  const l = $('#pick-launcher').value, sc = $('#pick-screensaver').value, an = $('#pick-anim').value, dn = $('#pick-dns').value;
  if (l !== String(home.launcher ?? '')) changes.launcher = l || null;
  if (sc !== String(home.screensaver ?? '')) changes.screensaver = sc || null;
  if (an !== String(home.animation_scale ?? '')) changes.animation_scale = an === '' ? null : +an;
  if (dn !== String(home.dns ?? '')) changes.dns = dn || null;
  if (Object.keys(changes).length) await post(`/api/tv/${S.selected}/home`, changes);
  S.opts.reboot = $('#pick-reboot').checked;
  const recipe = Object.entries(S.meta.recipes).find(([, r]) => r.length === steps.length && r.every((x) => steps.includes(x)));
  saveRecipe(recipe ? recipe[0] : 'full');
  closeModal();
  await post(`/api/tv/${S.selected}/run`, { mode, steps, reboot: mode === 'apply' && S.opts.reboot, measure: mode === 'apply' });
  S.viewRun = null;
  toast(`${mode === 'plan' ? 'preview' : 'run'} started: ${steps.join(', ')}`);
  await loadState(); await loadDetail(S.selected); renderLive();
  $('#sec-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function startRun(mode) {
  try {
    const body = { mode, reboot: mode === 'apply' ? S.opts.reboot : false, measure: mode !== 'plan' };
    await post(`/api/tv/${S.selected}/run`, body);
    S.viewRun = null;
    toast(`${mode} started`);
    await loadState();
    renderLive();
  } catch (e) { toast(e.message, true); }
}

const currentRunId = () => busyState().job?.run || S.live[S.selected]?.run;

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  try {
    if (a === 'select') selectTv(t.dataset.tv);
    else if (a === 'run') startRun(t.dataset.mode);
    else if (a === 'measure') {
      S.measuring = true; renderHead();
      try {
        await post(`/api/tv/${S.selected}/measure`);
        await loadState(); await loadDetail(S.selected); toast('measured');
      } finally { S.measuring = false; renderMain(); loadApps(); }
    } else if (a === 'stop') { await post(`/api/run/${currentRunId()}/stop`); toast('stopping after the current step'); }
    else if (a === 'continue') { await post(`/api/run/${currentRunId()}/continue`); toast('re-checking…'); }
    else if (a === 'confirm' || a === 'confirm-none') {
      const approved = a === 'confirm' ? [...document.querySelectorAll('[data-confirm]')].filter((c) => c.checked).map((c) => +c.dataset.confirm) : [];
      await post(`/api/run/${currentRunId()}/confirm`, { approved });
    } else if (a === 'apps-reload') loadApps(S.appsMem);
    else if (a === 'apps-mem') loadApps(true);
    else if (a === 'apps-tab') { S.appsFilter = t.dataset.tab; renderApps(); }
    else if (a === 'view-run') {
      S.viewRun = await api(`/api/tv/${S.selected}/runs/${t.dataset.run}`);
      renderLive(); $('#sec-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (a === 'back-live') { S.viewRun = null; renderLive(); }
    else if (a === 'restore') restoreModal();
    else if (a === 'run-picker') runPicker();
    else if (a === 'dial-reload') { S.dial = null; renderDial(); loadDial(); }
    else if (a === 'dial-go') { await post(`/api/tv/${S.selected}/dial/${encodeURIComponent(t.dataset.app)}/${t.dataset.op}`); toast(t.dataset.op === 'launch' ? 'opening on the TV…' : 'stopped'); setTimeout(loadDial, 2500); }
    else if (a === 'key') await post(`/api/tv/${S.selected}/key`, { key: t.dataset.key });
    else if (a === 'tz-reload') { S.tz = null; renderTizen(); loadTizen(); }
    else if (a === 'tz-setup') await post(`/api/tv/${S.selected}/tizen/setup`, {});
    else if (a === 'tz-accept') {
      const country = $('#tz-country')?.value.trim();
      closeModal();
      await post(`/api/tv/${S.selected}/tizen/setup`, { accept_license: true, country: country || null });
    } else if (a === 'tz-install') await post(`/api/tv/${S.selected}/tizen/install`, { app: t.dataset.app });
    else if (a === 'tz-uninstall') { if (confirm('Remove this app from the TV?')) await post(`/api/tv/${S.selected}/tizen/uninstall`, { app: t.dataset.app }); }
    else if (a === 'tz-dock-save') {
      const order = [...document.querySelectorAll('[data-dock]')].filter((c) => c.checked).map((c) => c.dataset.dock);
      await post(`/api/tv/${S.selected}/tizen/dock`, { dock: order }); toast('dock saved: reinstall Override Home to apply'); loadTizen();
    } else if (a === 'pair-remote') {
      S.pairing = true; renderDial();
      try { await post(`/api/tv/${S.selected}/pair-remote`); toast('paired: keys and apps work now'); } finally { S.pairing = false; await loadDial(); }
    } else if (a === 'type-send') {
      const text = $('#type-text')?.value || '';
      if (text) { await post(`/api/tv/${S.selected}/type`, { text }); $('#type-text').value = ''; toast('typed on the TV'); }
    } else if (a === 'cam') {
      S.cam = await post('/api/phonecam', { tv: S.selected, on: t.dataset.on === '1' });
      renderScreen();
    }
    else if (a === 'prep-toggle') { const g = S.prep.data?.guide; const p = prepProgress(g); S.prep.show = !(S.prep.show ?? !(g && p.reqLeft === 0 && p.done === p.total)); renderPrep(); }
    else if (a === 'prep-open') {
      S.prep.open = S.prep.open === t.dataset.step ? '' : t.dataset.step; renderPrep();
      if (S.prep.open && !S.screen.live && onlineOf(S.selected) && !isNet()) setLive(true);  // follow along on the live screen
    } else if (a === 'prep-step') await prepStep(t.dataset.op, t.dataset.step);
    else if (a === 'prep-discover') { S.prep.loading = true; renderPrep(); await post(`/api/tv/${S.selected}/discover`); await loadPrep(false); toast('TV data refreshed'); }
    else if (a === 'prep-rebuild') { if (confirm('Replace the guide with the built-in steps from the presets? Progress on matching steps is lost.')) { await post(`/api/tv/${S.selected}/guide/rebuild`); await loadPrep(false); } }
    else if (a === 'prep-research') {
      await post(`/api/tv/${S.selected}/guide/research`);
      const online = S.agent.seen && Date.now() - new Date(S.agent.seen) < 90000;
      toast(online ? 'the agent is researching this model; the guide updates here when it is done' : 'queued for the agent: it researches when it next checks in (or ask it in the chat)');
      loadPrep(false);
    }
    else if (a === 'screen-live') setLive(!S.screen.live);
    else if (a === 'screen-now') screenTick(true);
    else if (a === 'screen-size') { S.screen.big = !S.screen.big; $('.screen-wrap')?.classList.toggle('big', S.screen.big); }
    else if (a === 'screen-full') window.open(`/api/tv/${S.selected}/screen?w=0&token=${encodeURIComponent(window.TOKEN)}`, '_blank', 'noopener');
    else if (a === 'screen-save' && S.screen.url) {
      const link = document.createElement('a');
      link.href = S.screen.url; link.download = `${S.selected}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; link.click();
    }
    else if (a === 'recipe') {
      const steps = new Set(S.meta.recipes[t.dataset.recipe]);
      document.querySelectorAll('[data-step]').forEach((c) => { if (!c.disabled) c.checked = steps.has(c.dataset.step); });
      document.querySelectorAll('[data-action="recipe"]').forEach((b) => b.setAttribute('aria-selected', b === t));
    } else if (a === 'picker-go') await pickerGo(t.dataset.mode);
    else if (a === 'revert') revertModal(t.dataset.run);
    else if (a === 'revert-go') {
      const keep = $('#revert-keep').checked;
      closeModal();
      await post(`/api/tv/${S.selected}/run`, { mode: 'revert', run_id: t.dataset.run, keep, measure: true });
      S.viewRun = null; toast(`reverting run ${t.dataset.run}…`); await loadState(); renderLive();
      $('#sec-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (a === 'explain') {
      await post('/api/inbox', { tv: S.selected, topic: 'explain', text: t.dataset.q });
      const online = S.agent.seen && Date.now() - new Date(S.agent.seen) < 90000;
      toast(online ? 'asked the agent: the answer appears in the agent panel' : 'queued: the agent answers when it next checks in (or ask in the chat)');
    }
    else if (a === 'restore-go') {
      if ($('#confirm-name').value.trim() !== S.selected) { toast('name does not match', true); return; }
      closeModal(); startRun('restore');
    } else if (a === 'open-play') { await post(`/api/tv/${S.selected}/open-play`, { package: t.dataset.pkg }); toast('opened on the TV'); }
    else if (a === 'add-tv') addTvModal();
    else if (a === 'scan') {
      addTvModal(null, true);
      try {
        const r = await post('/api/find', {});
        addTvModal(r.found, false, r.networks);
      } catch (err) { addTvModal(null, false); toast(err.message, true); }
    } else if (a === 'pick-host') { $('#new-host').value = t.dataset.host; $('#new-port').value = t.dataset.port || 5555; $('#new-name').focus(); }
    else if (a === 'pair-start') pairBox(t.dataset.host, t.dataset.port);
    else if (a === 'pair-go') {
      t.disabled = true;
      try {
        await post('/api/pair', { host: t.dataset.host, port: +$('#pair-port').value, code: $('#pair-code').value.trim() });
        $('#pair-box').innerHTML = '<p class="st st-done">✓ paired. Now give it a name and connect.</p>';
        $('#new-host').value = t.dataset.host; $('#new-port').value = t.dataset.port; $('#new-name').focus();
      } catch (err) { toast(err.message, true); t.disabled = false; }
    } else if (a === 'move-tv') {
      await post(`/api/tv/${t.dataset.tv}/address`, { host: t.dataset.host, port: +t.dataset.port });
      closeModal(); toast(`${t.dataset.tv} now at ${t.dataset.host}`);
      await loadState(); selectTv(t.dataset.tv);
    }
    else if (a === 'init') {
      const host = $('#new-host').value.trim(), name = $('#new-name').value.trim(), port = +($('#new-port').value || 5555);
      if (!host || !name) { toast('IP and name are required', true); return; }
      t.disabled = true;
      $('#init-status').innerHTML = '<span class="spin">◌</span> connecting… if the TV shows <b>Allow USB debugging?</b>, tick "Always allow" and press Allow.';
      try {
        const r = await post('/api/init', { host, name, port });
        closeModal(); toast(`added ${r.name}: ${r.model}`);
        await loadState(); selectTv(r.name);
      } catch (err) { $('#init-status').textContent = '✖ ' + err.message; t.disabled = false; }
    } else if (a === 'modal-close' || (a === 'modal-bg' && e.target === t)) closeModal();
    else if (a === 'ask-yes' || a === 'ask-no') await answerAsk(t.dataset.id, a === 'ask-yes');
    else if (a === 'ask-all' || a === 'ask-none') document.querySelectorAll(`[data-ask="${t.dataset.id}"]`).forEach((c) => (c.checked = a === 'ask-all'));
    else if (a === 'ask-chat') { await post(`/api/ask/${t.dataset.id}/cancel`, { reason: 'chat' }); toast('the agent will ask you in the chat'); }
    else if (a === 'ask-send') {
      const it = S.agent.items.find((i) => i.id === t.dataset.id);
      let answer;
      if (it.kind === 'choice') {
        const r = document.querySelector(`input[name="ask-${it.id}"]:checked`);
        if (!r) { toast('pick one option', true); return; }
        answer = it.options[+r.value].value;
      } else if (it.kind === 'multi') answer = [...document.querySelectorAll(`[data-ask="${it.id}"]`)].filter((c) => c.checked).map((c) => it.options[+c.value].value);
      else if (it.kind === 'text') answer = $(`#ask-text-${it.id}`).value.trim();
      else answer = 'done';
      await answerAsk(it.id, answer);
    } else if (a === 'topic') { S.topic = S.topic === t.dataset.topic ? null : t.dataset.topic; renderAgent(); }
    else if (a === 'inbox-send') {
      const text = $('#inbox-text').value.trim();
      if (!text && (!S.topic || S.topic === 'message')) { toast('write a message or pick a topic', true); return; }
      await post('/api/inbox', { tv: S.selected, topic: S.topic || 'message', text });
      $('#inbox-text').value = ''; S.topic = null; renderAgent();
      toast('sent: the agent picks it up when it next checks in');
    } else if (a === 'note-dismiss') await post(`/api/agent/${t.dataset.id}/dismiss`);
    else if (a === 'keys-reload') { S.keys = null; renderKeys(); loadKeys(); }
    else if (a === 'store-reload') { S.store = null; renderStore(); loadStore(); }
    else if (a === 'store-install') await appRun('install', t.dataset.app);
    else if (a === 'store-update') await appRun('update', t.dataset.app);
    else if (a === 'store-uninstall') uninstallModal(t.dataset.app, t.dataset.name);
    else if (a === 'store-uninstall-go') { closeModal(); await appRun('uninstall', t.dataset.app); }
    else if (a === 'store-open') { await post(`/api/tv/${S.selected}/open`, { package: t.dataset.pkg }); toast('opened on the TV'); }
    else if (a === 'keys-learn') {
      await post(`/api/tv/${S.selected}/keys/capture`, { seconds: 20 });
      clearInterval(S.capture.timer);
      S.capture.timer = setInterval(() => { if (S.capture.state !== 'listening') clearInterval(S.capture.timer); renderKeys(); }, 1000);
    } else if (a === 'key-map') keyEditor(t.dataset.scan, t.dataset.label);
    else if (a === 'key-edit') keyEditor(t.dataset.scan, '');
    else if (a === 'key-remove') {
      if (!confirm(`Remove the mapping for button ${t.dataset.scan}? It goes back to its original function.`)) return;
      await post(`/api/tv/${S.selected}/keys/${t.dataset.scan}/delete`);
      toast('mapping removed'); loadKeys(); loadDetail(S.selected).then(renderHead);
    } else if (a === 'key-try') {
      const k = S.keys.keys.find((x) => x.scan === +t.dataset.scan);
      await post(`/api/tv/${S.selected}/keys/${k.scan}/try`, k.action ? { action: k.action, package: k.package } : { open: k.open });
      toast('opened on the TV');
    } else if (a === 'key-try-modal' || a === 'key-save') {
      const v = $('#key-target').value;
      if (!v) { toast('choose an app first', true); return; }
      const scan = $('#key-scan').value, target = targetFromValue(v);
      if (a === 'key-try-modal') { await post(`/api/tv/${S.selected}/keys/${scan}/try`, target); toast('opened on the TV'); return; }
      const r = await post(`/api/tv/${S.selected}/keys/${scan}`, { label: $('#key-label').value.trim(), ...target });
      closeModal(); toast(r.pushed ? 'saved and pushed to the TV: press the button to test' : r.note);
      S.capture.presses = []; loadKeys(); loadDetail(S.selected).then(renderHead);
    }
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-opt]')) { S.opts[t.dataset.opt] = t.checked; return; }
  if (t.id === 'pick-launcher') { updateHomeHint(); return; }
  if (t.id === 'pick-dns') { updateDnsHint(); return; }
  if (t.id === 'screen-interval') { S.screen.interval = +t.value; if (S.screen.live) screenTick(); return; }
  if (t.matches('[data-step]')) { document.querySelectorAll('[data-action="recipe"]').forEach((b) => b.setAttribute('aria-selected', false)); return; }
  if (t.matches('select.decision')) {
    t.disabled = true;
    try {
      await post(`/api/tv/${S.selected}/apps`, { package: t.dataset.pkg, decision: t.value });
      toast(`${t.dataset.pkg} → ${t.value} (saved to profile, re-planning…)`);
      await loadDetail(S.selected); renderHead();
      loadApps(S.appsMem);
    } catch (err) { toast(err.message, true); t.disabled = false; }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-action="apps-search"]')) {
    S.appsQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderApps();
    const s = $('[data-action="apps-search"]'); s.focus(); s.setSelectionRange(pos, pos);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.matches('tr[data-action]')) e.target.click();
  if (e.key === 'Enter' && e.target.id === 'type-text') $('[data-action="type-send"]')?.click();
});

/* tooltips for chart marks */
const tip = () => $('#tooltip');
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  tip().innerHTML = t.dataset.tip; tip().hidden = false;
});
document.addEventListener('mousemove', (e) => {
  if (tip().hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - 330);
  tip().style.left = x + 'px'; tip().style.top = e.clientY + 14 + 'px';
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tip().hidden = true; });

/* ------------------------------------------------------------------ boot */

function tick() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); renderAgentChip(); }

(async function boot() {
  tick(); setInterval(tick, 1000);
  S.meta = await api('/api/workflow-meta').catch(() => ({ steps: {}, recipes: { full: [] }, launchers: [], screensavers: [] }));
  await loadState();
  connectEvents();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('tv');
  const first = S.tvs.find((t) => t.name === fromHash) || S.tvs[0];
  if (first) selectTv(first.name); else renderMain();
  setInterval(loadState, 20000);
})();
