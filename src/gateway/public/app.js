const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Which thread you were reading survives a page load.
 *
 * The app used to be a single page you never left, so in-memory state was
 * enough. With Runs and Evals as real destinations, leaving and coming back is
 * ordinary navigation, and losing the open conversation each time is not.
 *
 * localStorage can throw outright (private windows, embedded frames with site
 * data blocked), so every access is guarded and the app simply starts fresh
 * when it is unavailable.
 */
const store = {
  get(key) {
    try {
      return localStorage.getItem(`lumina.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`lumina.${key}`);
      else localStorage.setItem(`lumina.${key}`, value);
    } catch {
      /* nothing to persist to; the session stays in-memory */
    }
  },
};

const state = {
  mode: store.get('mode') === 'deep' ? 'deep' : 'quick',
  threadId: null,
  busy: false,
};

/**
 * The identity credential the gateway issued us.
 *
 * A cookie is the primary carrier, but inside a cross-site frame the browser may
 * drop it, and then every request looks like a new user: the thread just created
 * cannot be reopened and the run list comes back empty. Storage does survive
 * there, so the credential is kept and replayed on each request as a fallback.
 */
function authHeaders() {
  const token = store.get('token');
  return token ? { 'x-lumina-token': token } : {};
}

function rememberIdentity(res) {
  const token = res.headers.get('x-lumina-token');
  if (token) store.set('token', token);
}

/** Single place that owns the active thread, so persistence cannot drift. */
function setThread(id) {
  state.threadId = id;
  store.set('thread', id);
}

/* ------------------------------------------------------------------ utils */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtMs = (ms) => (ms == null ? 'n/a' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtUsd = (v) => (v == null ? 'n/a' : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`);
const fmtNum = (n) => (n == null ? 'n/a' : n.toLocaleString());
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  rememberIdentity(res);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
  return data;
}

/**
 * Minimal markdown → HTML. Everything is escaped first; citation markers become
 * clickable chips that highlight the matching source card.
 */
function renderAnswer(markdown, sources = []) {
  const valid = new Set(sources.map((s) => s.n));
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const lines = esc(markdown).split('\n');
  const html = [];
  let list = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      html.push(`<h2>${inline(heading[2], valid, byNumber)}</h2>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(bullet[1], valid, byNumber)}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(numbered[1], valid, byNumber)}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line, valid, byNumber)}</p>`);
  }
  closeList();
  return html.join('');
}

function inline(text, valid, byNumber = new Map()) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[(\d+(?:,\s*\d+)*)\]/g, (match, group) =>
      group
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => !valid.size || valid.has(n))
        .map((n) => {
          // The marker carries its own evidence so a reader can check a claim by
          // hovering it, without losing their place in the answer.
          const s = byNumber.get(n);
          const label = s ? `Source ${n}: ${s.title}` : `Source ${n}`;
          return `<a class="cite" data-n="${n}" href="#source-${n}" aria-label="${esc(label)}"${
            s ? ` data-title="${esc(s.title || '')}" data-domain="${esc(s.locator || s.domain || '')}" data-snippet="${esc((s.snippet || '').slice(0, 320))}"` : ''
          }>${n}</a>`;
        })
        .join('') || match,
    );
}

/* ------------------------------------------------------ citation previews */

/**
 * Hovering a [n] marker shows the evidence it cites, in place.
 *
 * Clicking already jumps to the source card, but jumping costs the reader their
 * place in the sentence they were checking. The whole promise is "citations you
 * can check", so checking one should not require leaving the claim.
 */
const citeTip = (() => {
  let el = null;
  const ensure = () => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'cite-tip';
      el.setAttribute('role', 'tooltip');
      el.hidden = true;
      document.body.append(el);
    }
    return el;
  };

  return {
    show(cite) {
      const snippet = cite.dataset.snippet;
      if (!snippet) return;
      const tip = ensure();
      tip.innerHTML = `<div class="cite-tip-head">${esc(cite.dataset.title || '')}</div>
        <div class="cite-tip-domain">${esc(cite.dataset.domain || '')}</div>
        <div class="cite-tip-body">${esc(snippet)}</div>`;
      tip.hidden = false;

      // Prefer above the marker; flip below when there is no room, and keep the
      // whole tip inside the viewport horizontally.
      const r = cite.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const margin = 8;
      const above = r.top - t.height - margin;
      tip.style.top = `${(above > 0 ? above : r.bottom + margin) + window.scrollY}px`;
      const left = Math.min(Math.max(margin, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - margin);
      tip.style.left = `${left + window.scrollX}px`;
    },
    hide() {
      if (el) el.hidden = true;
    },
  };
})();

document.addEventListener('mouseover', (e) => {
  const cite = e.target.closest?.('.cite');
  if (cite) citeTip.show(cite);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.cite')) citeTip.hide();
});
// Keyboard users get the same preview: the markers are links, so they focus.
document.addEventListener('focusin', (e) => {
  const cite = e.target.closest?.('.cite');
  if (cite) citeTip.show(cite);
});
document.addEventListener('focusout', (e) => {
  if (e.target.closest?.('.cite')) citeTip.hide();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  citeTip.hide();
  if (document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
    document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false');
  }
});

/* ------------------------------------------------------------ tool display */

/**
 * The trace is shown to a person, so it reads as prose rather than as the raw
 * JSON argument object the model actually emitted.
 */
function describeToolInput(tool, input) {
  if (!input || typeof input !== 'object') return esc(String(input ?? ''));
  const reason = input.reason ? ` · ${esc(input.reason)}` : '';
  switch (tool) {
    case 'web_search':
      return `“${esc(input.query || '')}”${input.recency && input.recency !== 'any' ? ` · ${esc(input.recency)}` : ''}`;
    case 'fetch_page': {
      let shown = input.url || '';
      try {
        const u = new URL(input.url);
        shown = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
      } catch {
        /* a malformed URL is shown as-is */
      }
      return `${esc(shown.length > 68 ? `${shown.slice(0, 66)}…` : shown)}${reason}`;
    }
    case 'search_documents':
      return `“${esc(input.query || '')}” in uploaded documents`;
    case 'remember':
      return esc(input.content || input.text || '');
    default:
      return esc(JSON.stringify(input).slice(0, 160));
  }
}

/* --------------------------------------------------------- screen announcer */

/** One polite live region: phase changes, not every streamed token. */
const announce = (() => {
  let el = null;
  return (message) => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'sr-only';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      document.body.append(el);
    }
    el.textContent = message;
  };
})();

/* ------------------------------------------------------------- turn render */

function createTurn(question, mode) {
  const el = document.createElement('article');
  el.className = 'turn';
  el.innerHTML = `
    <div class="question">${esc(question)}<span class="badge ${mode === 'deep' ? 'deep' : ''}">${mode === 'deep' ? 'Deep Search' : 'Quick'}</span></div>
    <div data-slot="notice"></div>
    <div data-slot="plan"></div>
    <div class="section-label">Activity <span class="spinner" data-slot="spinner"></span></div>
    <details class="trace" open>
      <summary><span data-slot="trace-summary">starting…</span><span data-slot="trace-budget"></span></summary>
      <div class="trace-body" data-slot="trace"></div>
    </details>
    <div data-slot="sources-wrap"></div>
    <div data-slot="answer-wrap"></div>
    <div data-slot="metrics"></div>`;
  $('#empty-state')?.remove();
  $('#conversation').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const slots = Object.fromEntries($$('[data-slot]', el).map((n) => [n.dataset.slot, n]));
  return { el, slots, t0: performance.now(), sources: [], answer: '' };
}

function traceRow(turn, kind, key, value, status = '') {
  const row = document.createElement('div');
  row.className = `trace-row ${status}`;
  row.innerHTML = `<span class="t">${((performance.now() - turn.t0) / 1000).toFixed(1)}s</span><span class="k">${esc(key)}</span><span class="v">${value}</span>`;
  turn.slots.trace.append(row);
  turn.slots.trace.scrollTop = turn.slots.trace.scrollHeight;
  turn.slots['trace-summary'].textContent = kind;
}

function renderSources(turn, sources, considered) {
  turn.sources = sources;
  turn.el._sources = sources;
  if (!sources.length) {
    turn.slots['sources-wrap'].innerHTML =
      '<div class="notice warn">No sources were retrieved for this question, so the answer below is not grounded in evidence.</div>';
    return;
  }
  turn.slots['sources-wrap'].innerHTML = `
    <div class="section-label">Sources · ${sources.length}${considered?.length ? ` <span style="color:var(--text-faint);font-weight:400;text-transform:none;letter-spacing:0">(${considered.length} more found but not read)</span>` : ''}</div>
    <div class="sources">${sources
      .map((s) =>
        s.type === 'document'
          ? `<div class="source doc" id="source-${s.n}"><div class="n">${s.n}</div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.locator || 'document')}</div></div>`
          : `<a class="source" id="source-${s.n}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><div class="n">${s.n}${s.from_cache ? ' ·cached' : ''}</div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.domain || '')}</div></a>`,
      )
      .join('')}</div>`;
}

function renderMetrics(turn, done) {
  const groundedness = done.citations?.groundedness;
  const bits = [
    `<span><b>${done.mode}</b></span>`,
    `<span title="End-to-end time for the run">total <b>${fmtMs(done.latency_ms)}</b></span>`,
    `<span title="Time until the first answer token. Research happens before this.">first token <b>${fmtMs(done.ttft_ms)}</b></span>`,
    `<span title="Priced from the model's reported token usage">cost <b>${fmtUsd(done.cost_usd)}</b></span>`,
    `<span title="Tokens sent to the model, and generated by it">tokens <b>${fmtNum(done.tokens?.input)} in / ${fmtNum(done.tokens?.output)} out</b></span>`,
    `<span title="Cached tool results reused, versus calls that had to run">cache <b>${done.cache?.hits ?? 0} hits / ${done.cache?.misses ?? 0} misses</b></span>`,
    `<span title="Tool calls the model made">tools <b>${done.tool_calls ?? 0}</b></span>`,
    `<span title="Sources actually cited in the answer, out of the pages that were read">cited <b>${done.citations?.valid ?? 0} of ${done.sources?.fetched ?? 0} read</b></span>`,
    groundedness != null
      ? `<span class="${groundedness < 0.6 ? 'flag' : ''}" title="Share of cited sentences whose wording is supported by the source they cite. A lexical check, not entailment: it catches a citation pointing at the wrong source, but not a fluent paraphrase of something the source never said.">grounded <b>${(groundedness * 100).toFixed(0)}% of cited sentences</b></span>`
      : '',
    done.citations?.invalid ? `<span class="flag">dropped <b>${done.citations.invalid}</b> bad citations</span>` : '',
    `<span title="Why the run ended">stopped: <b>${esc(done.termination_reason || 'completed')}</b></span>`,
    `<span style="color:var(--text-faint)">${esc(done.run_id || '')}</span>`,
  ];
  turn.slots.metrics.innerHTML = `<div class="metrics">${bits.filter(Boolean).join('')}</div>`;
}

/* ------------------------------------------------------------------- query */

async function ask(question) {
  if (state.busy || !question.trim()) return;
  state.busy = true;
  $('#ask').disabled = true;
  const turn = createTurn(question, state.mode);

  let answerEl = null;
  let doneData = null;

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ query: question, mode: state.mode, thread_id: state.threadId || undefined }),
    });

    rememberIdentity(res);

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Request failed (${res.status})`);
    }

    for await (const { event, data } of readSse(res.body)) {
      handleEvent(event, data);
    }
  } catch (err) {
    turn.slots.notice.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  } finally {
    turn.slots.spinner?.remove();
    answerEl?.setAttribute('aria-busy', 'false');
    if (doneData) renderMetrics(turn, doneData);
    state.busy = false;
    $('#ask').disabled = false;
    refreshSidebar();
  }

  function handleEvent(event, data) {
    switch (event) {
      case 'run_start':
        setThread(data.thread_id);
        announce(`Researching: ${question}`);
        traceRow(turn, 'researching', 'run', `${esc(data.mode)} · model ${esc(data.model)} · search via ${esc(data.search_provider)}`);
        break;
      case 'context':
        traceRow(
          turn,
          'researching',
          'context',
          `${data.thread_turns} prior turns · ${data.memories_injected} memories · ${data.documents_indexed} docs`,
        );
        break;
      case 'memory_used':
        traceRow(turn, 'researching', 'memory', data.memories.map((m) => esc(m.content)).join(' · '), 'ok');
        break;
      case 'plan':
        renderPlan(turn, data);
        traceRow(turn, 'planning', 'plan', `${data.sub_questions.length} sub-questions`, 'ok');
        break;
      case 'branch_start':
        traceRow(turn, 'researching', `branch ${esc(data.id)}`, esc(data.question));
        break;
      case 'branch_done':
        markPlanDone(turn, data.id);
        traceRow(turn, 'researching', `branch ${esc(data.id)} ✓`, `${data.sources} sources · ${esc(data.termination_reason)}`, data.capped ? 'fail' : 'ok');
        break;
      case 'branch_skipped':
        traceRow(turn, 'researching', `branch ${esc(data.id)} ✗`, `skipped: ${esc(data.reason)}`, 'fail');
        break;
      case 'iteration':
        turn.slots['trace-budget'].textContent = budgetLabel(data.budget);
        break;
      case 'tool_call':
        traceRow(turn, 'researching', `→ ${esc(data.tool)}`, describeToolInput(data.tool, data.input));
        turn.slots['trace-budget'].textContent = budgetLabel(data.budget);
        break;
      case 'tool_result':
        traceRow(
          turn,
          'researching',
          `← ${esc(data.tool)}`,
          `${esc(data.summary)} · ${fmtMs(data.duration_ms)}${data.refunded ? ' · budget refunded' : ''}`,
          data.ok ? 'ok' : 'fail',
        );
        break;
      case 'tool_blocked':
        traceRow(turn, 'capped', `✗ ${esc(data.tool)}`, `blocked: ${esc(data.reason)}`, 'fail');
        break;
      case 'sweep_start':
        traceRow(turn, 'researching', 'sweep', `checking ${data.considering} cross-branch candidates`);
        break;
      case 'capped':
        turn.slots.notice.innerHTML = `<div class="notice warn"><span>⚠</span><span>${esc(data.explanation)}</span></div>`;
        break;
      case 'sources':
        // Arrives before any answer token, by construction.
        renderSources(turn, data.sources, data.considered_not_read);
        traceRow(turn, 'writing answer', 'sources', `${data.count} citable`, 'ok');
        announce(`${data.count} sources gathered. Writing the answer.`);
        turn.slots['answer-wrap'].innerHTML =
          '<div class="section-label">Answer<button type="button" class="copy-answer" data-copy-answer title="Copy the answer with its numbered sources">Copy</button></div>' +
          '<div class="answer" aria-busy="true"></div>';
        answerEl = $('.answer', turn.slots['answer-wrap']);
        break;
      case 'token':
        turn.answer += data.text;
        turn.el._answerText = turn.answer;
        if (answerEl) answerEl.innerHTML = renderAnswer(turn.answer, turn.sources) + '<span class="caret"></span>';
        break;
      case 'answer':
        turn.answer = data.text;
        turn.el._answerText = turn.answer;
        if (answerEl) {
          answerEl.innerHTML = renderAnswer(turn.answer, turn.sources);
          answerEl.setAttribute('aria-busy', 'false');
        }
        if (data.revised) traceRow(turn, 'verifying', 'citations', 'ungrounded citation markers were removed', 'fail');
        break;
      case 'citations':
        traceRow(
          turn,
          'done',
          'grounding',
          `${data.cited.length} sources cited · ${data.supported_sentences}/${data.cited_sentences} cited sentences supported`,
          data.groundedness != null && data.groundedness < 0.6 ? 'fail' : 'ok',
        );
        break;
      case 'memory_saved':
        traceRow(turn, 'done', 'memory +', (data.memories || [data.memory]).filter(Boolean).map((m) => esc(m.content)).join(' · '), 'ok');
        break;
      case 'error':
        turn.slots.notice.innerHTML = `<div class="notice error"><span>✕</span><span>${esc(data.message)}</span></div>`;
        break;
      case 'done':
        doneData = data;
        announce(
          data.status === 'error'
            ? 'The run failed.'
            : `Answer complete. ${data.citations?.valid ?? 0} sources cited, ${data.sources?.fetched ?? 0} pages read.`,
        );
        turn.slots['trace-summary'].textContent = `${data.tool_calls} tool calls · ${fmtMs(data.latency_ms)}`;
        turn.el.querySelector('.trace').open = false;
        break;
      default:
        break;
    }
  }
}

const budgetLabel = (b) =>
  b?.used ? `${b.used.tool_calls}/${b.limits.maxToolCalls} tools · ${b.used.fetches}/${b.limits.maxFetches} fetches` : '';

function renderPlan(turn, plan) {
  turn.slots.plan.innerHTML = `
    <div class="section-label">Research plan</div>
    <div class="plan">
      <div class="interp">${esc(plan.interpretation)}</div>
      <ol>${plan.sub_questions
        .map((q) => `<li data-q="${esc(q.id)}">${esc(q.question)}${q.why ? `<span class="why">${esc(q.why)}</span>` : ''}</li>`)
        .join('')}</ol>
    </div>`;
}

const markPlanDone = (turn, id) => $(`[data-q="${id}"]`, turn.slots.plan)?.classList.add('done');

/** Parse an SSE body stream into events. */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        yield { event, data: JSON.parse(dataLines.join('\n')) };
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

/* ----------------------------------------------------------------- sidebar */

async function refreshSidebar() {
  const active = $('#side-tabs .active')?.dataset.tab;
  if (active === 'threads') loadThreads();
  if (active === 'memory') loadMemories();
  if (active === 'docs') loadDocs();
  if (active === 'runs') loadRuns();
  loadStatus();
}

async function loadStatus() {
  try {
    const caps = await api('/capabilities');
    $('#status').textContent = `search: ${caps.active.search} · embeddings: ${caps.active.embeddings} · cache ${caps.cache.hit_rate ?? 'n/a'}`;
  } catch {
    $('#status').textContent = 'agent unreachable';
  }
}

async function loadThreads() {
  const { items } = await api('/threads');
  $('#thread-list').innerHTML =
    items
      .map(
        (t) => `<div class="item ${t.id === state.threadId ? 'active' : ''}" data-thread="${esc(t.id)}">
          ${esc(t.title)}<div class="meta"><span>${t.message_count} messages</span><span>${ago(t.last_activity_at)}</span></div>
          <button class="kill" data-del-thread="${esc(t.id)}" title="Delete thread">×</button></div>`,
      )
      .join('') || '<p class="panel-note">No threads yet.</p>';
}

async function loadMemories() {
  const { items } = await api('/memories');
  $('#memory-list').innerHTML =
    items
      .map(
        (m) => `<div class="item">${esc(m.content)}
          <div class="meta"><span>${esc(m.kind)}</span><span>${esc(m.source)}</span><span>${ago(m.created_at)}</span></div>
          <button class="kill" data-del-memory="${esc(m.id)}" title="Forget this">×</button></div>`,
      )
      .join('') || '<p class="panel-note">Nothing remembered yet.</p>';
}

async function loadDocs() {
  const { items, stats } = await api('/documents');
  $('#doc-list').innerHTML =
    items
      .map((d) => {
        const pending = d.status !== 'indexed' && d.status !== 'failed';
        return `<div class="item">${esc(d.filename)}
          <div class="meta">
            <span>${d.status === 'failed' ? `failed: ${esc(d.error || '')}` : esc(d.stage)}</span>
            ${d.chunk_count ? `<span>${d.chunk_count} chunks</span>` : ''}
            ${d.page_count ? `<span>${d.page_count} pages</span>` : ''}
          </div>
          ${pending ? `<div class="progress"><i style="width:${Math.round((d.progress || 0) * 100)}%"></i></div>` : ''}
          <button class="kill" data-del-doc="${esc(d.id)}" title="Delete document">×</button></div>`;
      })
      .join('') || '<p class="panel-note">No documents indexed.</p>';

  if (items.some((d) => d.status !== 'indexed' && d.status !== 'failed')) setTimeout(loadDocs, 1200);
  if (stats) $('#doc-list').insertAdjacentHTML('afterbegin', `<p class="panel-note">${stats.indexed} indexed · ${stats.chunks} chunks searchable</p>`);
}

async function loadRuns() {
  const [{ items }, stats] = await Promise.all([api('/runs?limit=25'), api('/runs/stats')]);
  $('#run-stats').innerHTML = stats.runs
    ? `<div><b>${stats.runs}</b> runs · p50 <b>${fmtMs(stats.latency_ms.p50)}</b> · p95 <b>${fmtMs(stats.latency_ms.p95)}</b></div>
       <div>spend <b>${fmtUsd(stats.cost_usd.total)}</b> · avg <b>${fmtUsd(stats.cost_usd.avg)}</b></div>
       <div>cache hit rate <b>${stats.cache_hit_rate ?? 'n/a'}</b> · errors <b>${stats.errors}</b></div>`
    : '<div>No runs recorded yet.</div>';
  $('#run-list').innerHTML = items
    .map(
      (r) => `<div class="item">${esc(r.query.slice(0, 70))}
        <div class="meta"><span>${esc(r.mode)}</span><span>${fmtMs(r.latency_ms)}</span><span>${fmtUsd(r.cost_usd)}</span>
        <span>${esc(r.termination_reason || '')}</span></div></div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ events */

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const box = $('#question');
  const q = box.value.trim();
  box.value = '';
  box.style.height = 'auto';
  ask(q);
});

$('#question').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`;
});

$('#question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#mode-toggle').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-mode]');
  if (!button) return;
  state.mode = button.dataset.mode;
  store.set('mode', state.mode);
  $$('#mode-toggle button').forEach((b) => {
    b.classList.toggle('active', b === button);
    b.setAttribute('aria-checked', String(b === button));
  });
});

$('#side-tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-tab]');
  if (!button) return;
  $$('#side-tabs button').forEach((b) => b.classList.toggle('active', b === button));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === button.dataset.tab));
  refreshSidebar();
});

$('#new-thread').addEventListener('click', () => {
  setThread(null);
  $('#conversation').innerHTML =
    '<div class="empty" id="empty-state"><h1>New thread.</h1><p>Thread memory starts fresh. Long-term memory carries over.</p></div>';
  loadThreads();
});

document.addEventListener('click', async (e) => {
  const example = e.target.closest('#examples button');
  if (example) return ask(example.textContent.trim());

  // Copy the answer together with its numbered sources: a citation is worth
  // nothing pasted somewhere the reader cannot resolve [3].
  const copyBtn = e.target.closest('[data-copy-answer]');
  if (copyBtn) {
    const turnEl = copyBtn.closest('.turn');
    const text = turnEl?._answerText || turnEl?.querySelector('.answer')?.innerText || '';
    const sources = (turnEl?._sources || [])
      .map((src) => `[${src.n}] ${src.title}${src.url ? `\n    ${src.url}` : src.locator ? `, ${src.locator}` : ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(sources ? `${text}\n\nSources\n${sources}` : text);
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Press ⌘C';
    }
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1800);
    return;
  }

  const sidebarToggle = e.target.closest('#sidebar-toggle');
  if (sidebarToggle) {
    const open = document.body.classList.toggle('sidebar-open');
    sidebarToggle.setAttribute('aria-expanded', String(open));
    return;
  }

  // Tapping the conversation dismisses the overlaid sidebar, as an overlay panel
  // is expected to.
  if (document.body.classList.contains('sidebar-open') && !e.target.closest('.sidebar')) {
    document.body.classList.remove('sidebar-open');
    $('#sidebar-toggle')?.setAttribute('aria-expanded', 'false');
  }

  const cite = e.target.closest('.cite');
  if (cite) {
    e.preventDefault();
    const card = document.getElementById(`source-${cite.dataset.n}`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.classList.add('highlight');
    setTimeout(() => card?.classList.remove('highlight'), 1600);
    return;
  }

  const delThread = e.target.closest('[data-del-thread]');
  if (delThread) {
    await api(`/threads/${delThread.dataset.delThread}`, { method: 'DELETE' });
    if (state.threadId === delThread.dataset.delThread) setThread(null);
    return loadThreads();
  }

  const delMemory = e.target.closest('[data-del-memory]');
  if (delMemory) {
    await api(`/memories/${delMemory.dataset.delMemory}`, { method: 'DELETE' });
    return loadMemories();
  }

  const delDoc = e.target.closest('[data-del-doc]');
  if (delDoc) {
    await api(`/documents/${delDoc.dataset.delDoc}`, { method: 'DELETE' });
    return loadDocs();
  }

  const thread = e.target.closest('[data-thread]');
  if (thread) {
    // On narrow screens the sidebar overlays the conversation it just opened.
    document.body.classList.remove('sidebar-open');
    $('#sidebar-toggle')?.setAttribute('aria-expanded', 'false');
    return openThread(thread.dataset.thread);
  }
});

$('#memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#memory-input');
  if (!input.value.trim()) return;
  await api('/memories', { method: 'POST', body: JSON.stringify({ content: input.value.trim() }) });
  input.value = '';
  loadMemories();
});

$('#clear-memories').addEventListener('click', async () => {
  if (!confirm('Delete every long-term memory for this user?')) return;
  await api('/memories', { method: 'DELETE' });
  loadMemories();
});

$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append('files', file);
  const result = await api('/documents', { method: 'POST', body: form });
  if (result.rejected?.length) alert(result.rejected.map((r) => `${r.filename}: ${r.reason}`).join('\n'));
  e.target.value = '';
  loadDocs();
});

async function openThread(id) {
  const thread = await api(`/threads/${id}`);
  setThread(id);
  const conversation = $('#conversation');
  conversation.innerHTML = '';
  for (const message of thread.messages) {
    if (message.role === 'user') {
      conversation.insertAdjacentHTML(
        'beforeend',
        `<article class="turn"><div class="question">${esc(message.content)}<span class="badge ${message.mode === 'deep' ? 'deep' : ''}">${message.mode === 'deep' ? 'Deep Search' : 'Quick'}</span></div></article>`,
      );
    } else {
      const sources = message.sources || [];
      conversation.insertAdjacentHTML(
        'beforeend',
        `<article class="turn">
          ${sources.length ? `<div class="section-label">Sources · ${sources.length}</div><div class="sources">${sources
            .map((s) =>
              s.type === 'document'
                ? `<div class="source doc" id="source-${s.n}"><div class="n">${s.n}</div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.locator || '')}</div></div>`
                : `<a class="source" id="source-${s.n}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><div class="n">${s.n}</div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.domain || '')}</div></a>`,
            )
            .join('')}</div>` : ''}
          <div class="section-label">Answer</div>
          <div class="answer">${renderAnswer(message.content, sources)}</div>
        </article>`,
      );
    }
  }
  loadThreads();
}

/**
 * Restore what the last visit left open: the mode toggle, and the thread being
 * read. A stored thread can be gone (deleted, or belonging to an identity the
 * browser no longer has), so a failure quietly clears it rather than leaving a
 * dead reference or an error where the conversation should be.
 */
async function restoreSession() {
  const mode = state.mode;
  $$('#mode-toggle button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });

  const saved = store.get('thread');
  if (!saved) return;
  try {
    await openThread(saved);
  } catch {
    setThread(null);
  }
}

refreshSidebar();
restoreSession();
