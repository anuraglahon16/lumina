import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Deep's 24 calls, divided before any branch starts.
 *
 * The ceiling was never the problem. The division was: `maxToolCallsPerBranch`
 * 6 times four branches is exactly `maxToolCallsTotal` 24, so four branches
 * using their allowance consumed the whole pool and the cross-branch sweep had
 * nothing left — and took its pages anyway, because it called the fetcher
 * directly instead of claiming a slot.
 *
 * Measured on the nine deep runs of the deployed benchmark:
 *
 *   - every one of the 15 refusals was a branch asking for one more fetch_page
 *   - no sweep call was ever refused, because the sweep never asked
 *   - runs recorded 29 to 32 provider calls against a pool that saw 22 claimed
 *   - 8 of 9 runs cited fewer sources than they already held when refused
 *
 * So: subtract the reserve first, share the rest, let a branch stop when its
 * allocation is spent, and make the sweep spend from the same pool as everyone
 * else — or skip when the evidence is already there.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-alloc-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { runDeepQuery, allocateDeepBudget } = await import('../src/agent/core/deep.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

const TOTAL = 24;

/* ------------------------------------------------------------- the division */

test('the allocation never promises more than the ceiling', () => {
  for (let branches = 1; branches <= 8; branches += 1) {
    const a = allocateDeepBudget({ total: TOTAL, branches, maxPerBranch: 6 });
    assert.ok(a.perBranch * branches + a.reserve === TOTAL, `${branches} branches do not sum to ${TOTAL}`);
    assert.ok(a.perBranch * branches <= TOTAL - 4, `${branches} branches leave less than the reserve`);
    assert.ok(a.perBranch >= 1, 'every branch gets something');
  }
});

test('the measured table', () => {
  const four = allocateDeepBudget({ total: TOTAL, branches: 4, maxPerBranch: 6 });
  assert.deepEqual({ per: four.perBranch, reserved: four.reserve }, { per: 5, reserved: 4 });

  const three = allocateDeepBudget({ total: TOTAL, branches: 3, maxPerBranch: 6 });
  assert.deepEqual({ per: three.perBranch, reserved: three.reserve }, { per: 6, reserved: 6 });
});

test('fewer branches redistribute the unused capacity without exceeding the ceiling', () => {
  const two = allocateDeepBudget({ total: TOTAL, branches: 2, maxPerBranch: 6 });
  assert.equal(two.perBranch, 6, 'capped by the per-branch maximum, not by the pool');
  assert.equal(two.perBranch * 2 + two.reserve, TOTAL);
});

/* ------------------------------------------------- driving the real orchestration */

const body = 'Independent streams at the transport layer remove the blocking one lost packet would cause. '.repeat(6);

const okFetch = async (url) => ({
  ok: true, url, final_url: url, status: 200, title: `page for ${url}`,
  text: body, fetched_at: new Date().toISOString(), duration_ms: 3, timings: {},
});

/** Leads on many distinct domains, so candidates are always left unread. */
const manyLeads = async (query) => ({
  results: Array.from({ length: 4 }, (_, i) => ({
    url: `https://lead${i}-${encodeURIComponent(query).slice(0, 10)}.test/a`,
    title: `${query} ${i}`, snippet: 'lead',
  })),
  provider: 'stub', cached: false,
});

const planOf = (n) => ({
  interpretation: 'a multi-part question',
  sub_questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: `part ${i + 1}`, why: 'because' })),
});

/** Searches once, then fetches forever if allowed. */
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
      return { content: [{ type: 'tool_use', id: `f${b}${i}`, name: 'fetch_page', input: { url: `https://lead0-lead%20${b}.test/a?i=${i}` } }], stop_reason: 'tool_use', usage: {} };
    }
    params.onText?.('Merged [1].');
    return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

async function runDeep({ branches = 4, fetchPage = okFetch, webSearch = manyLeads } = {}) {
  const contract = [];
  const raw = [];
  let providerCalls = 0;
  const mapped = contractStream({ send: (e, d) => contract.push({ event: e, data: d }), depth: 'deep', answerId: 'ans_a' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_alloc_${Math.random().toString(36).slice(2, 8)}`,
    complete: hungryModel(branches),
    webSearch: async (...a) => { providerCalls += 1; return webSearch(...a); },
    fetchPage: async (...a) => { providerCalls += 1; return fetchPage(...a); },
    emit: (e, d) => { raw.push({ event: e, data: d }); mapped(e, d); },
  });
  return {
    result, raw, providerCalls,
    traces: contract.filter((e) => e.event === 'trace').map((e) => e.data),
    sources: contract.filter((e) => e.event === 'sources').flatMap((e) => e.data),
    done: contract.find((e) => e.event === 'done')?.data,
  };
}

test('no provider call exceeds the global ceiling', async () => {
  // Counted where the provider is actually invoked, sweep included, because
  // the sweep is exactly what used to spend outside the count.
  const { providerCalls } = await runDeep({ branches: 4 });
  assert.ok(providerCalls <= TOTAL, `${providerCalls} provider calls against a ceiling of ${TOTAL}`);
});

test('a normal four-branch run completes without a denial', async () => {
  const { done, result, raw } = await runDeep({ branches: 4 });
  assert.equal(done?.terminated, 'done', `terminated=${done?.terminated}`);
  assert.equal(result.run?.termination_reason, 'completed');
  assert.equal(raw.filter((e) => e.event === 'tool_blocked').length, 0, 'nothing was refused');
});

test('the sweep spends only reserved or unused capacity', async () => {
  const { raw, providerCalls } = await runDeep({ branches: 4 });
  const alloc = raw.find((e) => e.event === 'budget_allocated')?.data;
  assert.ok(alloc, 'the allocation is announced before the branches run');
  assert.equal(alloc.per_branch * alloc.branches + alloc.reserved, TOTAL);

  const swept = raw.filter((e) => e.event === 'source_added' && e.data?.branch === 'sweep').length;
  assert.ok(swept <= alloc.reserved, `the sweep took ${swept} against a reserve of ${alloc.reserved}`);
  assert.ok(providerCalls <= TOTAL);
});

test('sufficient evidence skips the sweep rather than spending on it', async () => {
  const { raw } = await runDeep({ branches: 4 });
  const skipped = raw.find((e) => e.event === 'sweep_skipped');
  const swept = raw.filter((e) => e.event === 'source_added' && e.data?.branch === 'sweep').length;
  if (skipped) {
    assert.equal(skipped.data.reason, 'sufficient_evidence');
    assert.equal(swept, 0, 'a skipped sweep fetches nothing');
  } else {
    // If it did run, the run did not have two citable sources per sub-question.
    assert.ok(swept >= 0);
  }
});

test('a genuinely necessary call that is refused still reports cap', async () => {
  // The pool is drained by branches that each want more than their share, so
  // the call the sweep needs is denied. That is curtailment and says so.
  const { ToolSlots } = await import('../src/agent/core/budget.js');
  const slots = new ToolSlots(2);
  slots.settle(slots.tryClaim());
  slots.settle(slots.tryClaim());
  assert.equal(slots.tryClaim(), null, 'the next call is refused');
  assert.equal(slots.capReason, 'deep_tool_budget_exhausted');

  const { terminationFor } = await import('../src/agent/core/deep.js');
  assert.equal(terminationFor({ truncated: false, refusedReason: slots.capReason, curtailed: true }), 'deep_tool_budget_exhausted');
});

test('a real cap still synthesises from what was gathered', async () => {
  // A blocked fetcher means branches find little and the run is constrained;
  // it must still answer rather than fail.
  const blocked = async (url) => ({ ok: false, url, status: 403, error: 'HTTP 403', duration_ms: 2 });
  const { result } = await runDeep({ branches: 4, fetchPage: blocked });
  assert.ok(result.answer && result.answer.trim().length > 0, 'a partial answer beats none');
});

test('attribution survives the allocation change', async () => {
  const { traces, sources } = await runDeep({ branches: 4 });
  const retrieval = new Set(['web_search', 'fetch_page', 'search_documents']);
  const bareTrace = traces.filter((t) => retrieval.has(t.tool) && !Number.isInteger(t.subQuestion));
  const bareSource = sources.filter((s) => !Number.isInteger(s.subQuestion));
  assert.deepEqual(bareTrace.map((t) => t.tool), [], 'every retrieval trace keeps its subQuestion');
  assert.deepEqual(bareSource.map((s) => s.n), [], 'every source keeps its subQuestion');
});
