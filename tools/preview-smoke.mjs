/**
 * Phase 6: the deployed preview, checked against the rubric's requirements.
 *
 * Every SSE frame and HTTP body is validated with the contract package's own
 * zod schemas rather than a second description of them here, because a
 * hand-written copy drifts and then reports conformance it never tested.
 *
 *   node tools/preview-smoke.mjs --target https://<preview>.vercel.app
 *
 * Users and Spaces are minted per run with a `smoke_` prefix so nothing lands
 * in normal user state.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

const BASE = flag('target', 'http://localhost:8787');
const PASSWORD = process.env.DEMO_PASSWORD || '';
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USER = `smoke_${STAMP}`;

const C = await import('../packages/contract/dist/index.js');

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${String(id).padStart(2)}. ${name}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
};

const H = (user = USER, extra = {}) => ({ 'x-user-id': user, 'content-type': 'application/json', ...extra });
const basic = () => (PASSWORD ? { authorization: `Basic ${Buffer.from(`smoke:${PASSWORD}`).toString('base64')}` } : {});

async function json(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...opts, headers: { ...H(opts.user), ...(opts.headers || {}) } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/** Ask, collecting every frame in order and validating each against the union. */
async function ask(threadId, payload, { user = USER, timeoutMs = 300000 } = {}) {
  // A run that never comes back is a finding, not a reason to abandon the
  // remaining checks: one transient timeout used to kill the whole smoke.
  let res;
  let raw;
  try {
    res = await fetch(`${BASE}/threads/${threadId}/ask`, {
      method: 'POST', headers: H(user), body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await res.text();
  } catch (err) {
    return { status: 0, frames: [], invalid: [], raw: '', error: `${err.name}: no response within ${timeoutMs}ms` };
  }
  const frames = [];
  const invalid = [];
  let event = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      const parsed = C.AskStreamEvent.safeParse({ event, data });
      if (!parsed.success) invalid.push({ event, issue: parsed.error.issues[0]?.message, path: parsed.error.issues[0]?.path?.join('.') });
      frames.push({ event, data });
    }
  }
  return { status: res.status, frames, invalid, raw };
}

const of = (frames, name) => frames.filter((f) => f.event === name).map((f) => f.data);
const last = (frames, name) => of(frames, name).at(-1);
const first = (frames, name) => frames.findIndex((f) => f.event === name);

async function main() {
  console.log(`\ntarget ${BASE}\nuser   ${USER}\n`);

  /* 3. health reflects the current code */
  const health = await json('/health');
  const healthOk = health.status === 200 && C.HealthResponse
    ? C.HealthResponse.safeParse(health.body).success
    : health.status === 200 && health.body?.status === 'ok';
  record(3, 'health responds and reports ok', healthOk && health.body?.status === 'ok', `db=${health.body?.db} vectorStore=${health.body?.vectorStore} quick=${health.body?.models?.quick} deepSynthesis=${health.body?.models?.deepSynthesis}`);

  /* 6 + 7. embeddings: local, intentional, not degraded */
  const agentHealth = await json('/api/health', { headers: basic() });
  const emb = agentHealth.body?.checks?.embedding_provider;
  record(6, 'Voyage is not the active embedding provider', emb === 'local', `embedding_provider=${emb} (status ${agentHealth.status})`);
  record(7, 'local embeddings are not reported as degraded', agentHealth.body?.status === 'ok' && agentHealth.body?.checks?.search_degraded === false,
    `status=${agentHealth.body?.status} search_degraded=${agentHealth.body?.checks?.search_degraded} vector_backend=${agentHealth.body?.checks?.vector_backend}`);

  /* 8. four contract probes */
  const probes = [];
  const t = await json('/threads', { method: 'POST', body: '{}' });
  probes.push([`POST /threads (${t.status})`, (t.status === 200 || t.status === 201) && C.CreateThreadResponse.safeParse(t.body).success]);
  const threadId = t.body?.threadId;
  const list = await json('/threads');
  probes.push(['GET /threads', list.status === 200 && C.ListThreadsResponse.safeParse(list.body).success]);
  const mem = await json('/memory');
  probes.push(['GET /memory', mem.status === 200 && C.ListMemoryResponse.safeParse(mem.body).success]);
  const noUser = await fetch(`${BASE}/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const noUserBody = await noUser.json().catch(() => null);
  probes.push(['POST /threads without X-User-Id → 401', noUser.status === 401 && Boolean(noUserBody)]);
  record(8, 'four contract probes pass', probes.every(([, ok]) => ok), probes.map(([n, ok]) => `${ok ? 'pass' : 'FAIL'} ${n}`).join('\n'));

  /* 4 + 5 + 9. a Quick web answer */
  // Unique per run: a repeated question is served from the search cache, and a
  // cache hit proves nothing about whether the provider still answers.
  const quick = await ask(threadId, { query: `How do Server-Sent Events differ from WebSockets? (probe ${STAMP})`, mode: 'web', depth: 'quick' });
  const qDone = of(quick.frames, 'done')[0];
  const qSources = last(quick.frames, 'sources') || [];
  const qTokens = of(quick.frames, 'token');
  const iSources = first(quick.frames, 'sources');
  const iToken = first(quick.frames, 'token');
  const searchTraces = of(quick.frames, 'trace').filter((x) => x.tool === 'web_search');

  record(4, 'a real Anthropic request succeeds', Boolean(qDone) && (qDone.tokens?.out ?? 0) > 0 && qTokens.length > 0,
    `tokens out=${qDone?.tokens?.out} model=${qDone?.model} cost=$${qDone?.costUsd}`);
  // Read after the run: `ok` on a trace means the tool returned, not that it
  // found anything. A 401 from the provider surfaced as ok:true with 0 results,
  // which this check used to accept.
  const afterSearch = await json('/api/health', { headers: basic() });
  const lastTavily = afterSearch.body?.checks?.search_last?.tavily;
  record(5, 'Tavily search runs live, returns results, no fallback', health.body?.searchProvider === 'tavily' && qSources.length > 0 && lastTavily?.ok !== false && qDone?.searchCached === false,
    `provider=${health.body?.searchProvider} web_search calls=${searchTraces.length} sources=${qSources.length} searchCached=${qDone?.searchCached}\nsearch_last=${JSON.stringify(afterSearch.body?.checks?.search_last)}`);
  record(9, 'Quick answer completes with sources before tokens', Boolean(qDone) && qSources.length > 0 && iSources !== -1 && iToken !== -1 && iSources < iToken && quick.invalid.length === 0,
    `sources=${qSources.length} at frame ${iSources}, first token at ${iToken}, invalid frames=${quick.invalid.length}, terminated=${qDone?.terminated}, ttft=${qDone?.ttftMs}ms`);

  /* 10. a Deep answer */
  const deepThread = (await json('/threads', { method: 'POST', body: '{}' })).body?.threadId;
  const deep = await ask(deepThread, { query: 'What are the tradeoffs between BM25 and dense vector retrieval?', mode: 'web', depth: 'deep' }, { timeoutMs: 600000 });
  const dPlan = of(deep.frames, 'plan')[0];
  const dTraces = of(deep.frames, 'trace');
  const dSources = last(deep.frames, 'sources') || [];
  const dDone = of(deep.frames, 'done')[0];
  const iPlan = first(deep.frames, 'plan');
  const iFirstTrace = first(deep.frames, 'trace');
  const retrievalTools = new Set(['web_search', 'fetch_page', 'search_documents']);
  const retrievalTraces = dTraces.filter((x) => retrievalTools.has(x.tool));
  const tracesMissingSub = retrievalTraces.filter((x) => !Number.isInteger(x.subQuestion) || x.subQuestion < 1);
  const sourcesMissingSub = dSources.filter((s) => !Number.isInteger(s.subQuestion) || s.subQuestion < 1);

  record('10a', 'Deep emits plan before any retrieval', Boolean(dPlan) && iPlan !== -1 && (iFirstTrace === -1 || iPlan < iFirstTrace),
    `plan at frame ${iPlan} with ${dPlan?.subQuestions?.length} sub-questions, first trace at ${iFirstTrace}`);
  record('10b', 'every retrieval trace carries an integer subQuestion', retrievalTraces.length > 0 && tracesMissingSub.length === 0,
    `${retrievalTraces.length - tracesMissingSub.length}/${retrievalTraces.length} traces carry one`);
  record('10c', 'every source carries an integer subQuestion', dSources.length > 0 && sourcesMissingSub.length === 0,
    `${dSources.length - sourcesMissingSub.length}/${dSources.length} sources carry one`);
  record('10d', 'Deep stays inside 24 tool calls', dTraces.length <= 24,
    `${dTraces.length} tool calls, terminated=${dDone?.terminated}, subQuestions=${dDone?.subQuestions}, invalid frames=${deep.invalid.length}`);

  /* 11. memory: save, appear, recall in a new thread, delete, disappear */
  const memUser = `smoke_mem_${STAMP}`;
  const mThread = (await json('/threads', { method: 'POST', body: '{}', user: memUser })).body?.threadId;
  await ask(mThread, { query: 'Remember that I am writing a thesis on retrieval-augmented generation.', mode: 'web', depth: 'quick' }, { user: memUser });
  const after = await json('/memory', { user: memUser });
  const rows = after.body?.memories || [];
  record('11a', 'an explicit save creates a memory row', rows.length > 0, `${rows.length} row(s): ${rows.map((r) => JSON.stringify(r.text)).join(' | ').slice(0, 160)}`);

  const newThread = (await json('/threads', { method: 'POST', body: '{}', user: memUser })).body?.threadId;
  const recall = await ask(newThread, { query: 'What am I writing about?', mode: 'web', depth: 'quick' }, { user: memUser });
  const recallText = of(recall.frames, 'token').map((x) => x.text).join('');
  // The fact must be in the answer, and the answer must not be a disclaimer
  // that happens to mention it later. A loose regex passed a run whose answer
  // opened "I don't have information about what you're writing about".
  const recalledFact = /thesis|retrieval-augmented/i.test(recallText);
  const disclaims = /^[^.]{0,120}(i don'?t have|the evidence does not|no information about)/i.test(recallText.trim());
  const recallTrace = of(recall.frames, 'trace').find((x) => x.tool === 'recall_memory');
  record('11b', 'a new thread recalls it', recalledFact && !disclaims,
    `recall_memory: ${recallTrace ? `${recallTrace.ok ? 'ok' : 'failed'} - ${recallTrace.reason ?? ''}` : 'not called'}\nanswer: ${recallText.replace(/\s+/g, ' ').slice(0, 200)}`);

  const delRes = rows.length ? await json(`/memory/${rows[0].id}`, { method: 'DELETE', user: memUser }) : { status: 0 };
  const afterDelete = await json('/memory', { user: memUser });
  const remaining = (afterDelete.body?.memories || []).filter((r) => r.id === rows[0]?.id);
  record('11c', 'delete removes the row', delRes.status === 200 || delRes.status === 204, `DELETE → ${delRes.status}`);
  record('11d', 'the deleted row is gone', remaining.length === 0, `id ${rows[0]?.id} absent; ${(afterDelete.body?.memories || []).length} unrelated row(s) remain`);

  /* 12. the daily Deep quota, on a disposable user */
  const capUser = `smoke_cap_${STAMP}`;
  const stats = await json('/stats', { user: capUser });
  const cap = stats.body?.deepDailyCap;
  const capThread = (await json('/threads', { method: 'POST', body: '{}', user: capUser })).body?.threadId;
  const accepted = [];
  for (let i = 0; i < cap; i += 1) {
    const r = await ask(capThread, { query: `Deep quota probe ${i + 1}: what is reciprocal rank fusion?`, mode: 'web', depth: 'deep' }, { user: capUser, timeoutMs: 600000 });
    accepted.push(r.status);
  }
  const statsBefore = await json('/stats', { user: capUser });
  const over = await fetch(`${BASE}/threads/${capThread}/ask`, {
    method: 'POST', headers: H(capUser), body: JSON.stringify({ query: 'one past the cap', mode: 'web', depth: 'deep' }),
  });
  const overBody = await over.json().catch(() => null);
  const statsAfter = await json('/stats', { user: capUser });
  const resetsAt = overBody?.resetsAt ?? overBody?.error?.resetsAt;
  const resetValid = Boolean(resetsAt) && !Number.isNaN(Date.parse(resetsAt)) && Date.parse(resetsAt) > Date.now();

  record('12a', `the first ${cap} Deep runs are accepted`, accepted.every((s) => s === 200), `statuses ${accepted.join(',')} (cap=${cap})`);
  record('12b', 'cap+1 is refused with a JSON 429', over.status === 429 && over.headers.get('content-type')?.includes('application/json') && Boolean(overBody),
    `status=${over.status} body=${JSON.stringify(overBody).slice(0, 200)}`);
  record('12c', 'the refusal carries a valid future resetsAt', resetValid, `resetsAt=${resetsAt}`);
  record('12d', 'the refused request creates no run', (statsAfter.body?.requests ?? -1) === (statsBefore.body?.requests ?? -2),
    `requests before=${statsBefore.body?.requests} after=${statsAfter.body?.requests}; deepToday=${statsAfter.body?.deepToday}`);

  /* 13 + 14. a document, and same-page sources with distinct real lines */
  const docUser = `smoke_doc_${STAMP}`;
  const space = await json('/spaces', { method: 'POST', body: JSON.stringify({ name: `smoke ${STAMP}` }), user: docUser });
  const spaceId = space.body?.spaceId;
  const file = 'eval/gold/corpus/retrieval-basics.pdf';
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), path.basename(file));
  const up = await fetch(`${BASE}/spaces/${spaceId}/documents`, { method: 'POST', headers: { 'x-user-id': docUser }, body: fd });
  const upBody = await up.json().catch(() => null);
  let indexed = false;
  let docStatus = 'never listed';
  for (let i = 0; i < 40 && !indexed; i += 1) {
    const docs = await json(`/spaces/${spaceId}/documents`, { user: docUser });
    const items = docs.body?.documents || [];
    docStatus = items.map((d) => `${d.status}${d.error ? `(${d.error})` : ''}`).join(',') || 'no rows';
    indexed = items.length > 0 && items.every((d) => d.status === 'indexed');
    if (!indexed) await new Promise((r) => setTimeout(r, 3000));
  }
  const docThread = (await json('/threads', { method: 'POST', body: '{}', user: docUser })).body?.threadId;
  const docAsk = await ask(docThread, { query: 'What chunk size and overlap does the course recommend, and what happens when chunks are too large?', mode: 'docs', depth: 'quick', spaceId }, { user: docUser });
  const docSources = (last(docAsk.frames, 'sources') || []).filter((s) => s.kind === 'doc');
  const docAnswer = of(docAsk.frames, 'token').map((x) => x.text).join('');

  record(13, 'a document uploads, indexes and answers', up.status === 202 && indexed && docSources.length > 0 && docAnswer.length > 0,
    `upload=${up.status} docId=${upBody?.docId} status=${docStatus} sources=${docSources.length} answerChars=${docAnswer.length}`);

  const byPage = new Map();
  for (const s of docSources) {
    const k = `${s.docId}:${s.locator?.page}`;
    byPage.set(k, [...(byPage.get(k) || []), s]);
  }
  const shared = [...byPage.entries()].filter(([, v]) => v.length > 1);
  const allHaveLine = docSources.every((s) => Number.isInteger(s.locator?.line) && s.locator.line > 0);
  const keys = docSources.map((s) => `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`);
  const distinct = new Set(keys).size === keys.length;
  record(14, 'same-page sources carry distinct real line locators', docSources.length >= 2 && allHaveLine && distinct,
    `${docSources.length} doc sources, ${new Set(keys).size} distinct keys, ${shared.length} page(s) with more than one source\n${docSources.map((s) => `[${s.n}] ${JSON.stringify(s.locator)}`).join(' ')}`);

  /* 15. /evals */
  const evalsReport = await json('/evals/report.json');
  const spaOpen = await fetch(`${BASE}/evals`, { headers: { accept: 'text/html' } });
  const spa = await fetch(`${BASE}/evals`, { headers: { accept: 'text/html', ...basic() } });
  const spaHtml = await spa.text();
  const r = evalsReport.body || {};
  const blob = JSON.stringify(r);
  record('15a', '/evals is served by the React app, not a server page', spa.status === 200 && /<div id="root">/.test(spaHtml) && !/No evaluation report yet/.test(spaHtml),
    `authenticated status=${spa.status} bytes=${spaHtml.length}; unauthenticated status=${spaOpen.status}${spaOpen.status === 401 ? ' (demo password gate - a grader needs the password)' : ''}`);
  record('15b', 'the report names Anurag Lahon', /Anurag Lahon/i.test(blob), `submission=${JSON.stringify(r.submission || r.author || null).slice(0, 160)}`);
  record('15c', 'a successful trajectory is present', /trajector/i.test(blob) && blob.length > 500 && /success/i.test(blob), `report keys: ${Object.keys(r).join(', ')}`);
  record('15d', 'a failing trajectory is present', /fail/i.test(blob), '');

  /* 16. nothing secret is browser-reachable */
  const leakTargets = ['/', '/assets/', '/evals/report.json', '/health', '/stats'];
  const needles = [/mongodb\+srv:\/\//i, /sk-ant-[A-Za-z0-9]/, /tvly-[A-Za-z0-9]{10}/, /pa-[A-Za-z0-9]{20}/, /ANTHROPIC_API_KEY\s*[:=]\s*["'][^"']+/];
  const leaks = [];
  for (const p of leakTargets) {
    const res = await fetch(`${BASE}${p}`, { headers: H() });
    const body = await res.text();
    for (const n of needles) if (n.test(body)) leaks.push(`${p} matched ${n}`);
  }
  const indexJs = (/src="(\/assets\/[^"]+\.js)"/.exec(spaHtml) || [])[1];
  if (indexJs) {
    const bundle = await (await fetch(`${BASE}${indexJs}`)).text();
    for (const n of needles) if (n.test(bundle)) leaks.push(`${indexJs} matched ${n}`);
  }
  record(16, 'no secret or connection string is browser-accessible', leaks.length === 0, leaks.length ? leaks.join('\n') : `checked ${leakTargets.length} routes + ${indexJs || 'no bundle'}`);

  const report = {
    ranAt: new Date().toISOString(),
    target: BASE,
    users: { primary: USER, memory: memUser, quota: capUser, documents: docUser },
    spaceId,
    results,
    passed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
  };
  fs.writeFileSync('reports/preview-smoke.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.passed} passed · ${report.failed} failed  →  reports/preview-smoke.json`);
  if (report.failed) process.exitCode = 1;
}

await main();
