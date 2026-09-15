import { shell } from './pageShell.js';

/**
 * `/runs`: the trace of a run you already made.
 *
 * The Activity panel shows a run's trace while it happens and then it is gone,
 * even though the run log has kept every step. This reconstructs one from
 * storage: phase timings, each tool call with duration and whether it was
 * cached or refunded, each model call with its model and cost, errors by phase,
 * and why the run stopped.
 *
 * Rendered on the client rather than server-side, because run data lives in the
 * agent behind the gateway's proxy and is scoped per user by the identity
 * cookie. Fetching it from the browser reuses that scoping exactly; rendering it
 * here would mean re-implementing it.
 */

const CSS = `
  .runs { display:grid; grid-template-columns: 290px 1fr; gap:16px; align-items:start; }
  @media (max-width: 780px) { .runs { grid-template-columns: 1fr; } }
  .run-item { display:block; width:100%; text-align:left; background:transparent; border:1px solid transparent;
              border-radius:9px; padding:9px 10px; margin-bottom:2px; cursor:pointer; color:inherit;
              font:inherit; text-decoration:none; }
  .run-item:hover { background:var(--bg); }
  .run-item.active { background:var(--bg); border-color:var(--ok); }
  .run-item .q { display:block; font-size:12.5px; line-height:1.35; margin-bottom:3px;
                 display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .run-item .meta { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .run-item .err { color:var(--bad); }
  .kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px 18px; margin-bottom:6px; }
  .kv div { font-size:12.5px; }
  .kv .k { color:var(--faint); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; display:block; }
  .kv b { font-family:var(--mono); font-size:12.5px; font-weight:550; }
  table.trace { width:100%; border-collapse:collapse; font-size:12.5px; }
  table.trace td { padding:4px 8px 4px 0; vertical-align:top; border-top:1px solid var(--border); }
  table.trace tr:first-child td { border-top:none; }
  td.t { font-family:var(--mono); color:var(--faint); white-space:nowrap; width:56px; }
  td.n { font-family:var(--mono); white-space:nowrap; width:120px; }
  td.n.ok { color:var(--ok); } td.n.bad { color:var(--bad); }
  td.d { word-break:break-word; color:var(--dim); }
  td.r { font-family:var(--mono); color:var(--faint); text-align:right; white-space:nowrap; }
  .pill { font-family:var(--mono); font-size:10px; padding:1px 6px; border-radius:20px; border:1px solid var(--border); color:var(--faint); margin-left:6px; }
  .empty { color:var(--dim); }
`;

const SCRIPT = `
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ms = (v) => v == null ? 'n/a' : v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's';
const usd = (v) => v == null ? 'n/a' : '$' + (v < 0.01 ? v.toFixed(5) : v.toFixed(4));
const num = (v) => v == null ? 'n/a' : v.toLocaleString();
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

// Same credential the Ask page stores, for the same reason: in a cross-site
// frame the cookie may not arrive, and without it this lists another user's
// runs, which is to say none.
function authHeaders() {
  try {
    const t = localStorage.getItem('lumina.token');
    return t ? { 'x-lumina-token': t } : {};
  } catch { return {}; }
}

async function api(p) {
  const r = await fetch(p, { credentials: 'same-origin', headers: authHeaders() });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function renderList(items, activeId) {
  if (!items.length) {
    return '<p class="empty">No runs yet. Ask something on the <a href="/">Ask</a> page and it will appear here.</p>';
  }
  return items.map((r) => {
    const bad = r.status === 'error';
    return '<a class="run-item' + (r.id === activeId ? ' active' : '') + '" href="/runs?id=' + encodeURIComponent(r.id) + '">' +
      '<span class="q">' + esc(r.query || '(no query)') + '</span>' +
      '<span class="meta' + (bad ? ' err' : '') + '">' + esc(r.mode || '?') + ' · ' + ms(r.latency_ms) + ' · ' + usd(r.cost_usd) +
      (bad ? ' · error' : '') + ' · ' + ago(r.started_at) + '</span></a>';
  }).join('');
}

function renderDetail(run) {
  const s = run.sources || {}, c = run.citations || {}, t = run.tokens || {}, ca = run.cache || {};
  const head = [
    ['status', esc(run.status || '?')],
    ['stopped', esc(run.termination_reason || '?')],
    ['latency', ms(run.latency_ms)],
    ['first token', ms(run.ttft_ms)],
    ['cost', usd(run.cost_usd)],
    ['tokens', num(t.input) + ' in / ' + num(t.output) + ' out'],
    ['cache', (ca.hits || 0) + ' hits / ' + (ca.misses || 0) + ' misses'],
    ['sources', (s.fetched || 0) + ' read, ' + (s.cited || 0) + ' cited'],
    ['grounded', c.groundedness == null ? 'n/a' : Math.round(c.groundedness * 100) + '%'],
  ].map(([k, v]) => '<div><span class="k">' + k + '</span><b>' + v + '</b></div>').join('');

  // One timeline, ordered by when each thing happened, so the run reads in the
  // order it actually ran rather than grouped by record type.
  const rows = [];
  for (const p of run.phases || []) {
    rows.push({ at: p.started_at_ms ?? 0, name: 'phase', cls: '', label: esc(p.name), detail: '', right: ms(p.duration_ms) });
  }
  for (const call of run.tool_calls || []) {
    const flags = (call.cached ? '<span class="pill">cached</span>' : '') + (call.branch ? '<span class="pill">' + esc(call.branch) + '</span>' : '');
    rows.push({
      at: call.at_ms ?? 0,
      name: (call.ok ? '→ ' : '✗ ') + esc(call.name),
      cls: call.ok ? 'ok' : 'bad',
      label: '',
      detail: esc(call.summary || '') + flags,
      right: ms(call.duration_ms),
    });
  }
  for (const call of run.llm_calls || []) {
    // Records land when the call returns; subtracting its duration puts it on
    // the timeline where it began, alongside the tool calls it sits between.
    const started = call.at_ms == null ? null : Math.max(0, call.at_ms - (call.duration_ms || 0));
    rows.push({
      at: started ?? 0,
      name: 'model',
      cls: '',
      detail: esc(call.purpose || '') + ' <span class="pill">' + esc(call.model || '') + '</span>' +
              (call.stop_reason ? '<span class="pill">' + esc(call.stop_reason) + '</span>' : ''),
      right: ms(call.duration_ms),
    });
  }
  for (const e of run.errors || []) {
    rows.push({ at: e.at_ms ?? 0, name: '✗ error', cls: 'bad', detail: esc(String(e.where || '') + ': ' + String(e.message || '').slice(0, 200)), right: '' });
  }
  // Steps with no recorded time (older runs, before llm calls were stamped)
  // sink to the end rather than claiming t=0 and leading the timeline.
  rows.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));

  const timeline = rows.length
    ? '<table class="trace">' + rows.map((r) =>
        '<tr><td class="t">' + (r.at ? (r.at / 1000).toFixed(1) + 's' : '') + '</td>' +
        '<td class="n ' + r.cls + '">' + r.name + '</td>' +
        '<td class="d">' + (r.label || '') + (r.detail || '') + '</td>' +
        '<td class="r">' + (r.right || '') + '</td></tr>').join('') + '</table>'
    : '<p class="empty">No steps recorded for this run.</p>';

  return '<div class="card"><h2>' + esc(run.query || '(no query)') +
    ' <span class="badge">' + esc(run.mode || '') + '</span></h2>' +
    '<div class="kv">' + head + '</div></div>' +
    '<div class="card"><h3>Trace <span class="dim">' + rows.length + ' steps, in the order they ran</span></h3>' +
    timeline + '</div>' +
    '<p class="faint mono" style="font-size:11px">' + esc(run.id || '') + '</p>';
}

async function main() {
  const wanted = new URLSearchParams(location.search).get('id');
  let items = [];
  try {
    items = (await api('/api/runs?limit=50')).items || [];
  } catch (err) {
    $('#list').innerHTML = '<p class="empty">Could not load runs: ' + esc(err.message) + '</p>';
    return;
  }

  const activeId = wanted || (items[0] && items[0].id);
  $('#list').innerHTML = renderList(items, activeId);
  if (!activeId) { $('#detail').innerHTML = ''; return; }

  try {
    $('#detail').innerHTML = renderDetail(await api('/api/runs/' + encodeURIComponent(activeId)));
  } catch (err) {
    $('#detail').innerHTML = '<div class="card"><p class="empty">Could not load that run: ' + esc(err.message) + '</p></div>';
  }
}
main();
`;

export function runsPage(req, res) {
  res.type('html').send(
    shell({
      title: 'LUMINA runs',
      active: '/runs',
      lede: 'Every run is logged with its full trace: what it called, how long each step took, what it cost, and why it stopped.',
      css: CSS,
      script: SCRIPT,
      body: `<div class="runs">
        <div class="card" id="list"><p class="empty">Loading…</p></div>
        <div id="detail"></div>
      </div>`,
    }),
  );
}
