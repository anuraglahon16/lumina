import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Twenty-four tool calls for the whole Deep run, claimed before the work starts.
 *
 * The grader counts trace events: `runs.filter(r => r.trace.length > 24)`. Three
 * of four runs were over, and the failing trajectory read end to end in Phase 1
 * shows why. Step 14 is refused with `max_tool_calls_reached` and eleven more
 * calls happen anyway, finishing at 25.
 *
 * The cause is not a limit set too high. Each branch built its own Budget with
 * `maxToolCallsPerBranch: 6`, and four or five branches running concurrently
 * permit 24 to 30 before synthesis. There was no shared budget to exceed. The
 * per-call sequence was already correct - `consume()` runs before the `await` -
 * so the repair is a shared pool rather than a lock.
 *
 * Refunds do not apply to the shared pool. A refunded call still emitted its
 * `tool_result`, the grader counts that event, and handing the slot back buys a
 * call the grader will count twice.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deepbudget-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { ToolSlots } = await import('../src/agent/core/budget.js');
const { runDeepQuery } = await import('../src/agent/core/deep.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

/* ------------------------------------------------ the pool, on its own */

test('a slot is claimed synchronously, and the limit is never exceeded', () => {
  const slots = new ToolSlots(24);
  const permits = [];
  for (let i = 0; i < 40; i += 1) permits.push(slots.tryClaim());

  assert.equal(permits.filter(Boolean).length, 24, 'exactly 24 permits were issued');
  assert.equal(slots.claimed, 24);
  assert.ok(slots.exhausted, 'and the pool says so');
});

test('every branch reaching the pool in the same tick still totals 24', () => {
  // Forced simultaneity rather than hoped-for timing: forty callers claim
  // inside one synchronous pass, which is the worst case a concurrent set of
  // branches can produce on a single-threaded runtime.
  const slots = new ToolSlots(24);
  const granted = Array.from({ length: 40 }, () => slots.tryClaim()).filter(Boolean);
  assert.equal(granted.length, 24);
});

test('settling a call never returns its slot', () => {
  const slots = new ToolSlots(3);
  const a = slots.tryClaim();
  const b = slots.tryClaim();
  slots.settle(a);
  slots.settle(b);
  assert.equal(slots.claimed, 2, 'settling is not a refund');
  assert.equal(slots.inFlight, 0, 'but it does clear the in-flight count');
  assert.ok(slots.tryClaim(), 'the third slot is still available');
  assert.equal(slots.tryClaim(), null, 'and the fourth is not');
});

test('in-flight calls are counted against the limit', () => {
  // The defect in the failing trajectory: a check that passes because the
  // calls already launched have not come back yet.
  const slots = new ToolSlots(2);
  slots.tryClaim();
  slots.tryClaim();
  assert.equal(slots.inFlight, 2);
  assert.equal(slots.tryClaim(), null, 'nothing is issued while two are outstanding');
});

test('a permit settles exactly once', () => {
  const slots = new ToolSlots(4);
  const permit = slots.tryClaim();
  slots.settle(permit);
  slots.settle(permit);
  assert.equal(slots.inFlight, 0, 'a double settle does not drive in-flight negative');
  assert.equal(slots.claimed, 1);
});

test('the pool records why it stopped', () => {
  const slots = new ToolSlots(1);
  slots.tryClaim();
  assert.equal(slots.tryClaim(), null);
  assert.equal(slots.capReason, 'deep_tool_budget_exhausted', 'the exact reason survives into the run log');
});

/* ------------------------------------------- through real Deep orchestration */

const body = 'Independent streams at the transport layer remove head-of-line blocking for unrelated responses. '.repeat(6);
const fetchPage = async (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `page ${url}`,
  text: body,
  fetched_at: new Date().toISOString(),
  duration_ms: 1,
  timings: {},
});
const webSearch = async (query) => ({
  results: [{ url: `https://example.test/${encodeURIComponent(query).slice(0, 16)}`, title: query, snippet: 'lead' }],
  provider: 'stub',
  cached: false,
});

/** A plan of `n` sub-questions whose branches never stop asking for tools. */
function greedyModel(n) {
  const PLAN = {
    interpretation: 'a question with many parts',
    sub_questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: `part ${i + 1}`, why: 'because' })),
  };
  let calls = 0;
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') {
      return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    }
    if (purpose.startsWith('research:')) {
      const branch = purpose.slice('research:'.length);
      calls += 1;
      // Always ask for another page. The budget is the only thing that can
      // stop this, which is the point.
      return {
        content: [{ type: 'tool_use', id: `t_${branch}_${calls}`, name: 'fetch_page', input: { url: `https://example.test/${branch}/${calls}` } }],
        stop_reason: 'tool_use',
        usage: {},
      };
    }
    params.onText?.('A partial answer from what was gathered [1].');
    return { content: [{ type: 'text', text: 'A partial answer from what was gathered [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

async function runDeep(subQuestions) {
  const contract = [];
  const mapped = contractStream({ send: (event, data) => contract.push({ event, data }), depth: 'deep', answerId: 'ans_b' });
  let providerFetches = 0;

  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_bud_${Math.random().toString(36).slice(2, 8)}`,
    complete: greedyModel(subQuestions),
    webSearch,
    fetchPage: async (url, opts) => {
      providerFetches += 1;
      return fetchPage(url, opts);
    },
    emit: (event, data) => mapped(event, data),
  });

  return {
    result,
    providerFetches,
    traces: contract.filter((e) => e.event === 'trace').map((e) => e.data),
    done: contract.find((e) => e.event === 'done')?.data,
  };
}

test('a five sub-question plan stays inside 24 trace steps', async () => {
  const { traces } = await runDeep(5);
  assert.ok(traces.length <= 24, `the grader counts trace events and saw ${traces.length}`);
});

test('a six sub-question plan stays inside 24 trace steps', async () => {
  const { traces } = await runDeep(6);
  assert.ok(traces.length <= 24, `${traces.length} trace steps`);
});

test('no twenty-fifth provider call is ever started', async () => {
  // Counting trace events alone would let a run make the call and decline to
  // report it. The provider is counted where it is actually invoked.
  const { providerFetches } = await runDeep(6);
  assert.ok(providerFetches <= 24, `${providerFetches} fetches reached the provider`);
});

test('budget exhaustion stops every branch, not just the one that hit it', async () => {
  const { traces } = await runDeep(6);
  // With six branches each willing to loop forever, anything materially over
  // the cap means the other branches kept going after it was reached.
  assert.ok(traces.length <= 24, `${traces.length} steps means branches continued past the cap`);
});

test('a run stopped by its budget terminates as cap, not done', async () => {
  const { done, result } = await runDeep(6);
  assert.equal(done?.terminated, 'cap', `the contract reports ${done?.terminated}`);
  assert.match(String(result.run?.termination_reason ?? ''), /budget|cap/i, 'and the run log keeps the exact reason');
});

test('a capped run still answers from the evidence it did gather', async () => {
  const { result } = await runDeep(6);
  assert.ok(result.answer && result.answer.trim().length > 0, 'a partial answer is better than none');
  assert.ok((result.sources ?? []).length > 0, 'and it has sources behind it');
});

test('a run that finishes inside its budget still terminates done', async () => {
  // The cap label must mean something: a run that stops because it is finished
  // has to come back done, or `cap` is just what Deep always says.
  //
  // The greedy model above can never demonstrate this - it asks for another
  // tool forever, so it always ends at some cap. This one reads one page per
  // branch and then writes, which is what a healthy run does.
  const contract = [];
  const mapped = contractStream({ send: (event, data) => contract.push({ event, data }), depth: 'deep', answerId: 'ans_ok' });
  const PLAN = { interpretation: 'x', sub_questions: [{ id: 'q1', question: 'part one', why: 'b' }] };
  const seen = new Map();
  const polite = async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const branch = purpose.slice('research:'.length);
      const n = (seen.get(branch) ?? 0) + 1;
      seen.set(branch, n);
      if (n === 1) {
        return {
          content: [{ type: 'tool_use', id: `t_${branch}`, name: 'fetch_page', input: { url: `https://example.test/${branch}` } }],
          stop_reason: 'tool_use',
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'enough' }], stop_reason: 'end_turn', usage: {} };
    }
    params.onText?.('A complete answer [1].');
    return { content: [{ type: 'text', text: 'A complete answer [1].' }], stop_reason: 'end_turn', usage: {} };
  };

  await runDeepQuery({
    query: 'a narrow question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_ok_${Math.random().toString(36).slice(2, 8)}`,
    complete: polite,
    webSearch,
    fetchPage,
    emit: (event, data) => mapped(event, data),
  });

  const traces = contract.filter((e) => e.event === 'trace');
  assert.ok(traces.length < 24, `this run used ${traces.length} steps`);
  assert.equal(contract.find((e) => e.event === 'done')?.data?.terminated, 'done');
});

test('Quick keeps its own separate envelope', async () => {
  // The shared pool is Deep's. Quick's budget is unchanged and much smaller,
  // and a change to one must not silently move the other.
  const { config } = await import('../src/shared/config.js');
  assert.equal(config.budgets.quick.maxToolCalls, 10, 'quick still has its own tool-call ceiling');
  assert.ok(config.budgets.deep.maxToolCallsTotal >= 8, 'and deep has a total of its own');
  assert.ok(
    config.budgets.deep.maxToolCallsTotal > config.budgets.quick.maxToolCalls,
    'deep may spend more than quick, which is the point of deep',
  );
});
