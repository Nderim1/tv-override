'use strict';
/* tv-override control center. Vanilla JS, no build step.
   Data: GET /api/state, /api/tv/:name, /api/tv/:name/apps, /api/tv/:name/runs/:id
   Live: SSE /api/events (workflow events from the dashboard's own runs and mirrored CLI runs). */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  tvs: [], selected: null, detail: null, lastRecord: null, viewRun: null,
  apps: null, appsLoading: false, appsError: null, appsFilter: 'all', appsQuery: '', appsMem: false,
  live: {}, measuring: false, opts: { reboot: true },
  agent: { items: [], seen: null },
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

function handleEvent(ev) {
  if (ev && ev.type === 'agent') return handleAgentEvent(ev);
  if (!ev || !ev.tv) return;
  const L = live(ev.tv);
  switch (ev.type) {
    case 'run':
      if (ev.status === 'running') {
        Object.assign(L, { run: ev.run, mode: ev.mode, source: ev.source || 'ui', state: 'running', phases: {}, rounds: [], perf: {}, waiting: null, record: null });
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
      loadApps();
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
    if (replaying && ev.type === 'agent') return;  // the agent desk is loaded from /api/agent instead
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
  if (!S.selected) return;
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

const onlineOf = (name) => S.tvs.find((t) => t.name === name)?.online;

async function selectTv(name) {
  S.selected = name; S.viewRun = null; S.apps = null; S.appsError = null;
  location.hash = `tv=${name}`;
  renderFleet();
  $('#main').innerHTML = `<div class="panel"><span class="spin">◌</span> loading ${esc(name)}…</div>`;
  try {
    await loadDetail(name);
  } catch (e) { toast(e.message, true); return; }
  renderMain();
  renderAgent();
  loadApps();
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
        <div class="meta">${esc(t.host)} · ${esc((t.presets || []).join(', ') || 'no presets')}</div>
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
    <section id="sec-agent"></section>
    <section id="sec-alert"></section>
    <section class="panel" id="sec-perf"></section>
    <section class="panel" id="sec-pipeline"></section>
    <section class="panel" id="sec-console">
      <div class="panel-head"><h2 class="panel-title"><b>[04]</b>console</h2><span class="hint">live workflow log</span></div>
      <div class="console" id="console" aria-live="polite"></div>
    </section>
    <section class="panel" id="sec-apps"></section>
    <section class="panel" id="sec-history"></section>
    <section class="panel danger" id="sec-danger"></section>`;
  renderLive();
  renderApps();
  renderHistory();
  renderDanger();
}

function renderLive() {
  if (!$('#sec-head')) return;
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
          <button class="btn btn-primary" data-action="run" data-mode="apply" ${dis}>▶ RUN WORKFLOW</button>
          <button class="btn" data-action="run" data-mode="plan" ${dis}>PLAN</button>
          <button class="btn" data-action="measure" ${dis || (S.measuring ? 'disabled' : '')}>${S.measuring ? '<span class="spin">◌</span> MEASURING' : 'MEASURE'}</button>
          <button class="btn" data-action="run" data-mode="verify" ${dis}>REBOOT &amp; VERIFY</button>
          ${running && !cli ? '<button class="btn btn-danger" data-action="stop">■ STOP</button>' : ''}
        </div>
        <label class="check"><input type="checkbox" data-opt="reboot" ${S.opts.reboot ? 'checked' : ''}> reboot after changes (accurate after-measurement)</label>
        ${!on ? '<span class="hint">TV unreachable: is it on, and is USB debugging enabled?</span>' : ''}
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
      <ol>${waiting.map((a) => `<li>${esc(a.detail)}<br><span class="pkg">${esc(a.step)} · ${esc(a.target)} · ${a.status === 'blocked' ? 'blocked until the step above is done' : 'needs you'}</span></li>`).join('')}</ol>
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
};
const PHASE_LABEL = { connect: 'connect', 'measure-before': 'measure ▸ before', apply: 'apply', plan: 'plan', reboot: 'reboot', 'measure-after': 'measure ▸ after', verify: 'verify', restore: 'restore' };

function pipelineSource() {
  if (S.viewRun) {
    const r = S.viewRun;
    const phases = Object.fromEntries((r.phases || []).map((p) => [p.name, p]));
    return { mode: r.mode, phases, rounds: r.rounds || [], state: r.outcome, run: r.id, source: r.source, historic: true };
  }
  const L = S.live[S.selected];
  if (L && L.run) return { mode: L.mode, phases: L.phases, rounds: L.rounds, state: L.state, run: L.run, source: L.source };
  return null;
}

function renderPipeline() {
  const el = $('#sec-pipeline');
  const src = pipelineSource();
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[02]</b>workflow</h2>
    <span class="row">${src ? `<span class="hint">${src.historic ? 'viewing' : 'live'} run ${esc(src.run)} · ${esc(src.mode)} · ${src.source === 'cli' ? 'terminal' : 'dashboard'}</span> ${st(src.state === 'running' ? 'running' : src.state)}` : ''}
    ${src?.historic ? '<button class="btn btn-sm" data-action="back-live">BACK TO LIVE</button>' : ''}</span></div>`;
  if (!src) {
    el.innerHTML = head + `<div class="empty">No run in this session. RUN WORKFLOW measures the TV, plans, applies the profile step by step, pauses when it needs you, then re-measures. PLAN is a dry run.</div>`;
    return;
  }
  const order = PHASES[src.mode] || Object.keys(src.phases);
  const L = S.live[S.selected];
  const waitingNow = !src.historic && ((busyState().job || {}).waiting || (busyState().job || {}).confirm || (L && L.state === 'running' && L.waiting));
  const steps = order.map((name, i) => {
    let p = src.phases[name];
    let status = p ? p.status : (src.state === 'running' ? 'pending' : 'skipped');
    if (status === 'running' && waitingNow && (name === 'apply' || name === 'restore')) status = 'waiting';
    return `<div class="step ${status}"><div class="n">${String(i + 1).padStart(2, '0')}</div><div class="t">${esc(PHASE_LABEL[name] || name)}</div>
      <div class="s">${st(status)}</div>${p?.detail ? `<div class="hint">${esc(p.detail)}</div>` : ''}</div>`;
  }).join('');
  const rounds = (src.rounds || []).filter(Boolean);
  const body = rounds.length ? rounds.map((acts, n) => {
    const shown = acts.filter((a) => a.status !== 'skipped');
    const counts = {};
    acts.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
    return `<div><div class="round-head"><span>${src.mode === 'plan' ? 'PLAN' : `ROUND ${n + 1}`} · ${acts.length} ACTION(S)</span>
      <span>${Object.entries(counts).map(([k, v]) => `${v} ${STATUS[k]?.[1] || k}`).join(' · ')}</span></div>
      ${shown.length ? `<div class="table-wrap" style="max-height:340px"><table class="t"><thead><tr><th>status</th><th>step</th><th>action</th><th>target</th><th>detail</th></tr></thead><tbody>
      ${shown.map((a) => `<tr><td>${st(a.status)}</td><td>${esc(a.step)}</td><td>${esc(a.action)}</td><td class="pkg-name">${esc(a.target)}</td><td class="pkg-note">${esc(a.detail)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">✓ nothing to change: the TV matches the profile</div>'}</div>`;
  }).join('') : '<div class="empty">Waiting for the plan…</div>';
  el.innerHTML = head + `<div class="stepper">${steps}</div><div class="rounds">${body}</div>`;
}

/* ------------------------------------------------------------------ console */

function renderConsole() {
  const el = $('#console');
  if (!el) return;
  const L = S.live[S.selected];
  const lines = L ? L.log : [];
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = lines.length
    ? lines.map((l) => `<div class="ln lv-${l.level}"><span class="ts">${esc(time(l.t))}</span>${esc(l.text)}</div>`).join('')
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
  const head = `<div class="panel-head"><h2 class="panel-title"><b>[03]</b>apps · keep / remove</h2>
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
      <td><div class="pkg-name">${esc(r.package)}</div>${r.note ? `<div class="pkg-note">${esc(r.note)}</div>` : ''}</td>
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
  el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[05]</b>run history</h2><span class="hint">${runs.length} run(s) · click to inspect</span></div>
    ${runs.length ? `<div class="table-wrap" style="max-height:320px"><table class="t"><thead><tr><th>when</th><th>mode</th><th>from</th><th>outcome</th><th>changes</th><th>RAM before → after</th></tr></thead><tbody>
    ${runs.map((r) => {
      const d = r.mem_before != null && r.mem_after != null ? r.mem_after - r.mem_before : null;
      return `<tr class="clickable" data-action="view-run" data-run="${esc(r.id)}" tabindex="0">
        <td>${esc(date(r.started))}</td><td>${esc(r.mode)}</td><td>${esc(r.source === 'cli' ? 'terminal' : r.source || '')}</td>
        <td>${st(r.outcome)}</td>
        <td class="mono">${r.summary?.changed ?? '–'}${r.summary?.disabled ? ` · ${r.summary.disabled} disabled` : ''}${r.summary?.uninstalled ? ` · ${r.summary.uninstalled} removed` : ''}</td>
        <td class="mono">${fmtMB(r.mem_before)} → ${fmtMB(r.mem_after)} MB ${d != null ? `<span class="${d >= 0 ? 'delta-up' : 'delta-down'}">(${d >= 0 ? '▲ +' : '▼ '}${d})</span>` : ''}${r.note ? `<div class="pkg-note">${esc(r.note)}</div>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No runs yet.</div>'}`;
}

function renderDanger() {
  const el = $('#sec-danger');
  if (!el) return;
  const restore = S.detail.runs.find((r) => r.mode === 'restore');
  const reinstall = restore?.summary?.reinstall || [];
  el.innerHTML = `<div class="panel-head"><h2 class="panel-title"><b>[06]</b>danger zone</h2></div>
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
      <div class="row" style="margin-top:8px"><span class="hint">Open your Claude Code chat to continue.</span><button class="btn btn-sm" data-action="note-dismiss" data-id="${n.id}">DISMISS</button></div></div>`).join('')}
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

function restoreModal() {
  modal(`<h2>⟲ Restore ${esc(S.selected)} to defaults?</h2>
    <p>Every disabled package comes back, the stock home screen returns, and screensaver/animations go back to how they were.
    This takes a minute; RAM use will go up again.</p>
    <div class="field"><label for="confirm-name">type the TV name to confirm</label><input id="confirm-name" autocomplete="off" placeholder="${esc(S.selected)}"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-danger" data-action="restore-go">RESTORE</button></div>`);
}

function addTvModal(found = null, scanning = false, nets = []) {
  modal(`<h2>+ Add a TV</h2>
    <p>On the TV: <b>Settings → System → About</b> → click <b>Build</b> 7× → back to <b>System → Developer options</b> → <b>USB debugging</b> on.</p>
    <div class="row"><button class="btn" data-action="scan" ${scanning ? 'disabled' : ''}>${scanning ? '<span class="spin">◌</span> SCANNING NETWORK…' : '⌕ SCAN NETWORK'}</button>
    ${nets.length ? `<span class="hint">scanned ${esc(nets.join(', '))}</span>` : ''}</div>
    ${found ? (found.length ? `<div class="table-wrap" style="margin-top:10px;max-height:220px"><table class="t"><thead><tr><th>ip</th><th>kind</th><th>name</th><th>adb</th><th></th></tr></thead><tbody>
      ${found.map((f) => `<tr><td>${esc(f.host)}</td><td>${esc(f.kind)}</td><td>${esc(f.name || '')}</td><td>${f.adb_enabled ? '<span class="st st-done">✓ on</span>' : '<span class="st st-manual">⚠ off</span>'}</td>
      <td>${f.profile ? `<span class="hint">profile: ${esc(f.profile)}</span>` : `<button class="btn btn-sm" data-action="pick-host" data-host="${esc(f.host)}">USE</button>`}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nothing found. TV on? Same network? You can still type the IP (Settings → Network on the TV).</div>') : ''}
    <div class="field"><label for="new-host">TV IP address</label><input id="new-host" placeholder="192.168.1.50" autocomplete="off"></div>
    <div class="field"><label for="new-name">name (room-brand)</label><input id="new-name" placeholder="kitchen-sony" autocomplete="off"></div>
    <p class="hint" id="init-status"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-action="modal-close">CANCEL</button>
    <button class="btn btn-primary" data-action="init">CONNECT &amp; CREATE PROFILE</button></div>`);
}

/* ------------------------------------------------------------------ actions */

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
    else if (a === 'restore-go') {
      if ($('#confirm-name').value.trim() !== S.selected) { toast('name does not match', true); return; }
      closeModal(); startRun('restore');
    } else if (a === 'open-play') { await post(`/api/tv/${S.selected}/open-play`, { package: t.dataset.pkg }); toast('opened on the TV'); }
    else if (a === 'add-tv') addTvModal();
    else if (a === 'scan') {
      addTvModal(null, true);
      const r = await post('/api/find', {});
      addTvModal(r.found, false, r.networks);
    } else if (a === 'pick-host') { $('#new-host').value = t.dataset.host; $('#new-name').focus(); }
    else if (a === 'init') {
      const host = $('#new-host').value.trim(), name = $('#new-name').value.trim();
      if (!host || !name) { toast('IP and name are required', true); return; }
      t.disabled = true;
      $('#init-status').innerHTML = '<span class="spin">◌</span> connecting… if the TV shows <b>Allow USB debugging?</b>, tick "Always allow" and press Allow.';
      try {
        const r = await post('/api/init', { host, name });
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
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-opt]')) { S.opts[t.dataset.opt] = t.checked; return; }
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
  await loadState();
  connectEvents();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('tv');
  const first = S.tvs.find((t) => t.name === fromHash) || S.tvs[0];
  if (first) selectTv(first.name); else renderMain();
  setInterval(loadState, 20000);
})();
