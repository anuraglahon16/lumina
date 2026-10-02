import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The run log says what the pool did, so it does not have to be inferred.
 *
 * The defect this exists to catch: the cross-branch sweep called the fetcher
 * directly instead of claiming a slot, so deployed runs made 29 to 32 provider
 * calls while the pool recorded 22 claimed and the grader — which counts trace
 * events, and the sweep emits none — saw a number under the ceiling. Every
 * figure looked fine and none of them was the truth.
 *
 * So the record distinguishes allocated from attempted from claimed from
 * settled from refused, and branch spending from sweep spending. The invariants
 * below are what make those numbers worth reading.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-poolobs-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { runDeepQuery } = await import('../src/agent/core/deep.js');
const { ToolSlots } = await import('../src/agent/core/budget.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

const TOTAL = 24;
const body = 'Independent streams at the transport layer remove head-of-line blocking. '.repeat(6);

const okFetch = async (url) => ({
  ok: true, url, final_url: url, status: 200, title: `page ${url}`,
  text: body, fetched_at: new Date().toISOString(), duration_ms: 2, timings: {},
});

const leads = async (query) => ({
  results: Array.from({ length: 4 }, (_, i) => ({
    url: `https://l${i}-${encodeURIComponent(query).slice(0, 10)}.test/a`, title: `${query} ${i}`, snippet: 'lead',
  })),
  provider: 'stub', cached: false,
});

const TOPICS = [
  'how ranking fusion combines two ordered candidate lists',
  'what latency cost a reranking stage adds to retrieval',
  'which chunk size preserves citation precision in documents',
  'when lexical scoring beats dense embeddings on rare terms',
  'why blocked publishers distort measured coverage on the web',
  'where vector index build time dominates ingestion',
];

const planOf = (n) => ({
  interpretation: 'a multi-part question',
  // Genuinely distinct: the plan validator drops sub-questions that reduce to
  // the same content words, so "part 1".."part 4" silently became three
  // branches and the fixtures tested a smaller plan than they claimed.
  sub_questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: TOPICS[i % TOPICS.length], why: 'because' })),
});

function hungryModel(n) {
  const seen = new Map();
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(planOf(n)) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const b = purpose.slice('research:'.length);
      const i = (seen.get(b) ?? 0) + 1;
      seen.set(b, i);
      if (i === 1) return { content: [{ type: 'tool_use', id: `s${b}`, name: 'web_search', input: { query: `lead ${b}` } }], stop_reason: 'tool_use', usage: {} };
      return { content: [{ type: 'tool_use', id: `f${b}${i}`, name: 'fetch_page', input: { url: `https://l0-lead%20${b}.test/a?i=${i}` } }], stop_reason: 'tool_use', usage: {} };
    }
    params.onText?.('Merged [1].');
    return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

async function runDeep({ branches = 4, fetchPage = okFetch, webSearch = leads } = {}) {
  const contract = [];
  const raw = [];
  let providerCalls = 0;
  const mapped = contractStream({ send: (e, d) => contract.push({ event: e, data: d }), depth: 'deep', answerId: 'a' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_obs_${Math.random().toString(36).slice(2, 8)}`,
    complete: hungryModel(branches),
    webSearch: async (...a) => { providerCalls += 1; return webSearch(...a); },
    fetchPage: async (...a) => { providerCalls += 1; return fetchPage(...a); },
    emit: (e, d) => { raw.push({ event: e, data: d }); mapped(e, d); },
  });
  return {
    result, raw, providerCalls,
    pool: result.run?.budget?.pool,
    terminated: contract.find((e) => e.event === 'done')?.data?.terminated,
    sources: contract.filter((e) => e.event === 'sources').flatMap((e) => e.data),
    traces: contract.filter((e) => e.event === 'trace').map((e) => e.data),
    logged: result.run?.tool_calls ?? [],
  };
}

/** Every invariant that must hold of any run, asserted in one place. */
function assertInvariants({ pool, providerCalls, terminated }, label) {
  assert.ok(pool, `${label}: the run log carries a pool summary`);
  assert.ok(pool.claimed <= pool.total_limit, `${label}: claimed ${pool.claimed} exceeds ${pool.total_limit}`);
  assert.equal(pool.settled, pool.claimed, `${label}: ${pool.claimed} claimed but ${pool.settled} settled`);
  assert.equal(pool.attempted, pool.claimed + pool.refused, `${label}: attempted is not claimed plus refused`);
  assert.equal(pool.branch_claimed + pool.sweep_claimed, pool.claimed, `${label}: owners do not account for every claim`);
  assert.equal(providerCalls, pool.claimed, `${label}: ${providerCalls} provider calls against ${pool.claimed} claims`);
  if (pool.refused > 0) assert.equal(terminated, 'cap', `${label}: ${pool.refused} refused but terminated=${terminated}`);
  if (pool.stop_reason === 'completed') {
    assert.equal(pool.refused, 0, `${label}: completed with ${pool.refused} refused`);
    assert.equal(pool.branch_refused, 0, `${label}: completed with ${pool.branch_refused} branch refusals`);
  }
  // A cap must name something that was actually refused. A deployed probe read
  // `refused: 0` beside `capped`, which looked like a contradiction and was
  // really a per-branch gate denying nine calls the pool never saw.
  if (pool.stop_reason === 'capped') {
    assert.ok(
      pool.refused > 0 || pool.branch_refused > 0,
      `${label}: capped with nothing refused - pool ${pool.refused}, branches ${pool.branch_refused}`,
    );
  }
}

test('normal completion: every claim settled, nothing refused, nothing outside the pool', async () => {
  const run = await runDeep({ branches: 4 });
  assertInvariants(run, 'normal');
  assert.equal(run.pool.stop_reason, 'completed');
  assert.equal(run.pool.refused, 0);
  assert.equal(run.pool.total_limit, TOTAL);
  assert.equal(run.pool.reserved, 4, 'four branches reserve four');
  assert.deepEqual(Object.values(run.pool.branch_allocations), [5, 5, 5, 5]);
});

test('the sweep spends from the pool and is counted as the sweep', async () => {
  const run = await runDeep({ branches: 4 });
  assertInvariants(run, 'sweep');
  assert.ok(run.pool.sweep_claimed <= run.pool.reserved, `sweep took ${run.pool.sweep_claimed} against a reserve of ${run.pool.reserved}`);
  // The point of the whole record: no provider call happens without a claim.
  assert.equal(run.providerCalls, run.pool.claimed);
});

test('a sweep skipped for sufficient evidence claims nothing', async () => {
  const run = await runDeep({ branches: 4 });
  const skipped = run.raw.find((e) => e.event === 'sweep_skipped');
  if (skipped) {
    assert.equal(skipped.data.reason, 'sufficient_evidence');
    assert.equal(run.pool.sweep_claimed, 0, 'a skipped sweep spends nothing');
  }
  assertInvariants(run, 'skipped');
});

test('a genuine refusal is recorded and agrees with the termination', () => {
  const slots = new ToolSlots(2);
  slots.settle(slots.tryClaim('branch'));
  slots.settle(slots.tryClaim('branch'));
  assert.equal(slots.tryClaim('sweep'), null);

  const s = slots.snapshot();
  assert.equal(s.attempted, 3);
  assert.equal(s.claimed, 2);
  assert.equal(s.refused, 1);
  assert.equal(s.settled, 2);
  assert.equal(s.by_owner.sweep, 0, 'a refused claim is not counted as spent');
  assert.equal(s.cap_reason, 'deep_tool_budget_exhausted');
});

test('a provider failure after a successful claim still settles', async () => {
  // A 403 is a spent slot, not a leaked one: the call was made.
  const blocked = async (url) => ({ ok: false, url, status: 403, error: 'HTTP 403', duration_ms: 2 });
  const run = await runDeep({ branches: 4, fetchPage: blocked });
  assertInvariants(run, 'provider failure');
  assert.equal(run.pool.settled, run.pool.claimed, 'a failed call is settled, not lost');
  assert.ok(run.result.answer.trim().length > 0, 'and the run still answers');
});

test('observability records rather than decides', () => {
  // The counters must not be readable by the decision. If tryClaim ever
  // consults attempted/refused/byOwner, the record starts steering the run.
  const source = fs.readFileSync(new URL('../src/agent/core/budget.js', import.meta.url), 'utf8');
  const claim = source.slice(source.indexOf('tryClaim(owner'), source.indexOf('/** Mark a claimed call finished'));
  assert.match(claim, /if \(this\.claimed >= this\.limit\)/, 'the decision is still claimed vs limit');
  for (const counter of ['this.attempted >', 'this.refused >', 'this.settled >', 'byOwner[']) {
    assert.ok(!claim.includes(`if (${counter}`), `tryClaim branches on ${counter}`);
  }
});

/* ------------------------------------------- the trace is the same record as the log */

/**
 * A fixture in which the sweep actually fetches.
 *
 * `hungryModel` keeps fetching, so the ledger passes two citable sources per
 * sub-question and the sweep skips itself for sufficient evidence - under which
 * the agreement test below passed with the fix reverted, proving nothing. Here
 * each branch searches once and reads one page, leaving the other leads unread,
 * which is the condition the sweep exists for.
 */
const sweepLeads = async (query) => ({
  results: [
    { url: `https://read-${encodeURIComponent(query).slice(0, 12)}.test/a`, title: query, snippet: 'lead' },
    { url: 'https://unread-one.test/x', title: 'cross-cutting one', snippet: 'lead' },
    { url: 'https://unread-two.test/y', title: 'cross-cutting two', snippet: 'lead' },
  ],
  provider: 'stub',
  cached: false,
});

function thriftyModel(n) {
  const seen = new Map();
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(planOf(n)) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const b = purpose.slice('research:'.length);
      const i = (seen.get(b) ?? 0) + 1;
      seen.set(b, i);
      if (i === 1) return { content: [{ type: 'tool_use', id: `s${b}`, name: 'web_search', input: { query: `lead ${b}` } }], stop_reason: 'tool_use', usage: {} };
      if (i === 2) return { content: [{ type: 'tool_use', id: `f${b}`, name: 'fetch_page', input: { url: `https://read-lead%20${b}.test/a` } }], stop_reason: 'tool_use', usage: {} };
      return { content: [{ type: 'text', text: `notes ${b}` }], stop_reason: 'end_turn', usage: {} };
    }
    params.onText?.('Merged [1].');
    return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

/** runDeep with the sweeping fixture, and the sweep's own count returned. */
async function runSweeping(branches = 3) {
  const contract = [];
  const raw = [];
  let providerCalls = 0;
  const mapped = contractStream({ send: (e, d) => contract.push({ event: e, data: d }), depth: 'deep', answerId: 'a' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_sweep_${Math.random().toString(36).slice(2, 8)}`,
    complete: thriftyModel(branches),
    webSearch: async (...a) => { providerCalls += 1; return sweepLeads(...a); },
    fetchPage: async (...a) => { providerCalls += 1; return okFetch(...a); },
    emit: (e, d) => { raw.push({ event: e, data: d }); mapped(e, d); },
  });
  return {
    result, raw, providerCalls,
    pool: result.run?.budget?.pool,
    terminated: contract.find((e) => e.event === 'done')?.data?.terminated,
    traces: contract.filter((e) => e.event === 'trace').map((e) => e.data),
    logged: result.run?.tool_calls ?? [],
    swept: raw.filter((e) => e.event === 'sweep_done').reduce((n, e) => n + (e.data?.fetched ?? 0), 0),
  };
}

test('the streamed trace accounts for every tool call the run log records', async () => {
  // The sweep wrote itself to the run log and emitted no tool_result, so the
  // two records disagreed by up to three fetch_page calls - and the grader
  // measures the trace, so the ceiling it enforced was the lower of the two
  // numbers. Agreement is the invariant; which number is larger is not the
  // point.
  const run = await runSweeping(3);
  assert.ok(run.swept > 0, 'the fixture reached the sweep, so this test is not vacuous');
  assertInvariants(run, 'trace/log agreement');

  const logged = run.logged.map((c) => c.name).sort();
  const traced = run.traces.map((t) => t.tool).sort();
  assert.deepEqual(traced, logged, 'every logged call is a trace step and vice versa');
});

test('the swept pages are exactly the sweep steps in the trace', async () => {
  const run = await runSweeping(3);
  assert.ok(run.swept > 0, 'the fixture reached the sweep');
  const sweepSteps = run.traces.filter((t) => t.tool === 'fetch_page' && /^sweep: /.test(t.reason ?? ''));
  assert.equal(sweepSteps.length, run.swept, 'no swept page is missing from the trace');
  for (const t of sweepSteps) {
    assert.ok(Number.isInteger(t.subQuestion) && t.subQuestion > 0, `a swept step names its sub-question, got ${t.subQuestion}`);
  }
});

test('the trace the grader counts stays inside the 24-call ceiling', async () => {
  // bench.mjs: `(r.run.trace ?? []).length > callCap` with callCap 24. Now that
  // the sweep's fetches are trace steps, this count went up by up to three, so
  // it is worth asserting rather than assuming the pool covers it.
  for (const branches of [3, 4, 6]) {
    const run = await runDeep({ branches });
    assert.ok(
      run.traces.length <= TOTAL,
      `${branches} branches produced ${run.traces.length} trace steps against a ceiling of ${TOTAL}`,
    );
    assert.ok(run.traces.length <= run.pool.total_limit, 'and never more than the pool allowed');
  }
});

test('a swept page is attributed, counted and claimed, all three', async () => {
  const run = await runSweeping(3);
  assert.ok(run.swept > 0, 'the fixture reached the sweep');
  const sweptSteps = run.traces.filter((t) => t.tool === 'fetch_page' && /^sweep: /.test(t.reason ?? ''));
  assert.ok(run.pool.sweep_claimed >= sweptSteps.length, `each swept page claimed a slot: ${run.pool.sweep_claimed} claims for ${sweptSteps.length} steps`);
  assert.equal(run.providerCalls, run.pool.claimed, 'and nothing reached the network outside the pool');
});
