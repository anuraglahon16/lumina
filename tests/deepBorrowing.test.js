import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An allocation is a fairness floor, not a fence.
 *
 * Measured on two deployed Deep probes: branches were refused six `fetch_page`
 * calls for URLs nobody had tried, while 6 to 15 of the 24 slots sat unused for
 * the rest of the run. The pool had capacity, the branch had work, and the
 * divider between them said no. The run then recorded `cap`, truthfully,
 * for work that could have been done inside the ceiling.
 *
 * So a branch that has spent its allocation asks the pool before it is refused,
 * and the pool lends only what nobody else is owed: every other active branch's
 * unspent guarantee comes off first, then the sweep's reserve. The ceiling is
 * unchanged at 24 and a refusal still means a refusal.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-borrow-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { ToolSlots } = await import('../src/agent/core/budget.js');
const { runDeepQuery } = await import('../src/agent/core/deep.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

const TOTAL = 24;

/* ------------------------------------------------------- the lending rule */

test('a branch borrows capacity another branch left unused', () => {
  const slots = new ToolSlots(TOTAL);
  for (const id of ['q1', 'q2', 'q3', 'q4']) slots.registerBranch(id, 5);
  slots.setSweepReserve(4);

  // q2, q3, q4 finish early having spent 2 each; q1 wants more than its 5.
  for (const id of ['q2', 'q3', 'q4']) {
    for (let i = 0; i < 2; i += 1) slots.settle(slots.tryClaim('branch', id));
    slots.finishBranch(id);
  }
  for (let i = 0; i < 5; i += 1) slots.settle(slots.tryClaim('branch', 'q1'));

  // 11 claimed, 4 held for the sweep, nothing owed to finished branches.
  assert.equal(slots.claimed, 11);
  assert.equal(slots.borrowable('q1'), TOTAL - 11 - 4, 'the rest is lendable');
  assert.ok(slots.borrowable('q1') > 0);
});

test('borrowing cannot starve an active branch of its guarantee', () => {
  const slots = new ToolSlots(TOTAL);
  for (const id of ['q1', 'q2', 'q3', 'q4']) slots.registerBranch(id, 5);
  slots.setSweepReserve(4);

  // q1 spends its five; the others are still running and have spent nothing.
  for (let i = 0; i < 5; i += 1) slots.settle(slots.tryClaim('branch', 'q1'));

  // 24 - 5 claimed - 15 owed to q2/q3/q4 - 4 sweep = 0.
  assert.equal(slots.borrowable('q1'), 0, 'nothing may be lent while others are owed their allocation');
});

test('the sweep reserve is protected from borrowing', () => {
  const slots = new ToolSlots(TOTAL);
  slots.registerBranch('q1', 5);
  slots.setSweepReserve(4);
  for (let i = 0; i < 5; i += 1) slots.settle(slots.tryClaim('branch', 'q1'));
  slots.finishBranch('q1');

  assert.equal(slots.borrowable('q1'), TOTAL - 5 - 4, 'the reserve stays out of reach');
});

test('an unnecessary sweep releases its reserve', () => {
  const slots = new ToolSlots(TOTAL);
  slots.registerBranch('q1', 5);
  slots.setSweepReserve(4);
  for (let i = 0; i < 5; i += 1) slots.settle(slots.tryClaim('branch', 'q1'));
  slots.finishBranch('q1');
  const before = slots.borrowable('q1');

  slots.releaseSweepReserve();
  assert.equal(slots.borrowable('q1'), before + 4, 'capacity nobody needs goes back to the pool');
});

test('lending never breaches the ceiling, including under concurrency', () => {
  const slots = new ToolSlots(TOTAL);
  for (const id of ['q1', 'q2', 'q3', 'q4']) slots.registerBranch(id, 5);
  // Every branch claims greedily and in an interleaved order, borrowing freely.
  let granted = 0;
  let refused = 0;
  for (let round = 0; round < 20; round += 1) {
    for (const id of ['q1', 'q2', 'q3', 'q4']) {
      const permit = slots.tryClaim('branch', id);
      if (permit) { granted += 1; slots.settle(permit); } else refused += 1;
    }
  }
  assert.equal(granted, TOTAL, `granted ${granted}, ceiling ${TOTAL}`);
  assert.equal(slots.claimed, TOTAL);
  assert.ok(refused > 0, 'and the rest were refused rather than quietly allowed');
  assert.equal(slots.settled, TOTAL);
});

test('a necessary call with nothing left to lend is refused', () => {
  const slots = new ToolSlots(4);
  slots.registerBranch('q1', 4);
  for (let i = 0; i < 4; i += 1) slots.settle(slots.tryClaim('branch', 'q1'));
  assert.equal(slots.borrowable('q1'), 0, 'nothing spare');
  assert.equal(slots.tryClaim('branch', 'q1'), null, 'so the call is refused');
  assert.equal(slots.capReason, 'deep_tool_budget_exhausted');
});

/* --------------------------------------------- driven through real orchestration */

const body = 'Reciprocal rank fusion sums one over k plus rank across ranked lists. '.repeat(6);
const okFetch = async (url) => ({
  ok: true, url, final_url: url, status: 200, title: `page ${url}`,
  text: body, fetched_at: new Date().toISOString(), duration_ms: 2, timings: {},
});
const leads = async (query) => ({
  results: Array.from({ length: 4 }, (_, i) => ({
    url: `https://b${i}-${encodeURIComponent(query).slice(0, 8)}.test/a`, title: `${query} ${i}`, snippet: 'lead',
  })),
  provider: 'stub', cached: false,
});
const TOPICS = [
  'how ranking fusion combines two ordered candidate lists',
  'what latency cost a reranking stage adds to retrieval',
  'which chunk size preserves citation precision in documents',
  'when lexical scoring beats dense embeddings on rare terms',
];
const PLAN = {
  interpretation: 'a multi-part question',
  sub_questions: TOPICS.map((q, i) => ({ id: `q${i + 1}`, question: q, why: 'because' })),
};

/** q1 is insatiable; the others stop after one fetch, leaving capacity spare. */
function lopsidedModel() {
  const seen = new Map();
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const b = purpose.slice('research:'.length);
      const n = (seen.get(b) ?? 0) + 1;
      seen.set(b, n);
      if (b !== 'q1' && n > 1) return { content: [{ type: 'text', text: `notes ${b}` }], stop_reason: 'end_turn', usage: {} };
      return { content: [{ type: 'tool_use', id: `f${b}${n}`, name: 'fetch_page', input: { url: `https://b0-lead.test/a?${b}=${n}` } }], stop_reason: 'tool_use', usage: {} };
    }
    params.onText?.('Merged [1].');
    return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

test('a real run lends spare capacity and stays inside the ceiling', async () => {
  const frames = [];
  let providerCalls = 0;
  const mapped = contractStream({ send: (e, d) => frames.push({ event: e, data: d }), depth: 'deep', answerId: 'a' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_bor_${Math.random().toString(36).slice(2, 8)}`,
    complete: lopsidedModel(),
    streamComplete: async (p) => { p.onText?.('Merged [1].'); return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} }; },
    webSearch: async (...a) => { providerCalls += 1; return leads(...a); },
    fetchPage: async (...a) => { providerCalls += 1; return okFetch(...a); },
    emit: (e, d) => mapped(e, d),
  });

  const pool = result.run?.budget?.pool;
  assert.ok(pool, 'the pool was recorded');
  assert.ok(pool.claimed <= TOTAL, `claimed ${pool.claimed} exceeds ${TOTAL}`);
  assert.equal(pool.settled, pool.claimed, 'every claim settled');
  assert.equal(providerCalls, pool.claimed, 'no provider call bypassed the pool');
  assert.ok(pool.borrowed >= 0, 'borrowing is recorded');
});

test('a branch stopped by its allocation with capacity spare is not refused', async () => {
  // The property the deployed probes violated: a refusal while safe capacity
  // remained. After borrowing, a refusal must mean there was nothing to lend.
  const frames = [];
  const mapped = contractStream({ send: (e, d) => frames.push({ event: e, data: d }), depth: 'deep', answerId: 'a' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_bor2_${Math.random().toString(36).slice(2, 8)}`,
    complete: lopsidedModel(),
    streamComplete: async (p) => { p.onText?.('Merged [1].'); return { content: [{ type: 'text', text: 'Merged [1].' }], stop_reason: 'end_turn', usage: {} }; },
    webSearch: leads,
    fetchPage: okFetch,
    emit: (e, d) => mapped(e, d),
  });
  const pool = result.run?.budget?.pool;
  if (pool.branch_refused > 0) {
    assert.equal(pool.claimed, TOTAL, `refused ${pool.branch_refused} calls with only ${pool.claimed} of ${TOTAL} claimed`);
  }
});
