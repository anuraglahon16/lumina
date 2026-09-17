import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Deep Search end to end, with the model and the tools faked.
 *
 * This file exists because of a specific failure: a variable referenced in
 * `runDeepQuery` that was never in scope there. The unit suite was green, every
 * piece it covered was correct, and every Deep run in the benchmark died with
 * `budget is not defined` — because nothing exercised the function that wires
 * the pieces together. Orchestration is not a detail between tested things; it
 * is where the bugs were.
 *
 * What is pinned here is the shape of a Deep run: that it plans before it
 * retrieves, that the plan reaches the caller, that branches get their own
 * budgets, that one branch failing does not take the run down, and that the
 * citation numbering that comes out is one merged sequence rather than each
 * branch's own.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deep-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';

const { runDeepQuery } = await import('../src/agent/core/deep.js');

const PLAN = {
  interpretation: 'what the user is really asking',
  sub_questions: [
    { id: 'q1', question: 'first part', rationale: 'because' },
    { id: 'q2', question: 'second part', rationale: 'also because' },
    { id: 'q3', question: 'third part' },
  ],
};

/** A model that plans once, has every branch read one page, then writes. */
function fakeModel({ onBranch } = {}) {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
    const purpose = params.purpose || '';

    if (purpose === 'plan') {
      return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    }

    if (purpose.startsWith('research:')) {
      const branch = purpose.slice('research:'.length);
      const override = onBranch?.(branch, calls.length);
      if (override) return override;
      const already = calls.filter((c) => c.purpose === purpose).length;
      if (already === 1) {
        return {
          content: [{ type: 'tool_use', id: `t_${branch}`, name: 'fetch_page', input: { url: `https://example.com/${branch}` } }],
          stop_reason: 'tool_use',
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: `notes for ${branch}` }], stop_reason: 'end_turn', usage: {} };
    }

    // Synthesis is a streaming call; the caller only reads text off the result.
    params.onText?.('The merged answer [1].');
    return { content: [{ type: 'text', text: 'The merged answer [1].' }], stop_reason: 'end_turn', usage: {} };
  };
  fn.calls = calls;
  return fn;
}

/** A tool executor that records a real source into the shared ledger. */
function fakeExecutor(ledgerSink) {
  return async (name, input) => {
    ledgerSink.push({ name, input });
    return { ok: true, content: 'page text about the topic', summary: 'read 1 page' };
  };
}

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }), names: () => events.map((e) => e.event) };
}

const run = (over = {}) =>
  runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: 'req_deep_1',
    ...over,
  });

test('a deep run plans before it retrieves, and the plan reaches the caller', async () => {
  // "A deep search that streams no plan is a slow quick search": the
  // decomposition is the feature, and it has to be visible before the work
  // starts or nobody can tell whether it was any good.
  const { emit, names, events } = collect();
  const calls = [];
  await run({ emit, complete: fakeModel(), executor: fakeExecutor(calls) });

  const planAt = names().indexOf('plan');
  const firstToolAt = names().findIndex((n) => n === 'tool_call');
  assert.ok(planAt >= 0, 'the plan is emitted');
  assert.ok(firstToolAt === -1 || planAt < firstToolAt, 'the plan comes before any retrieval');

  const plan = events[planAt].data;
  assert.equal(plan.sub_questions.length, 3);
});

test('every sub-question gets researched', async () => {
  const { emit } = collect();
  const model = fakeModel();
  const calls = [];
  await run({ emit, complete: model, executor: fakeExecutor(calls) });

  const branches = new Set(model.calls.filter((c) => c.purpose?.startsWith('research:')).map((c) => c.purpose));
  assert.equal(branches.size, 3, 'one research loop per sub-question');
  assert.equal(calls.length, 3, 'each branch read a page');
});

test('a run produces an answer and a merged citation numbering', async () => {
  const { emit } = collect();
  const calls = [];
  const result = await run({ emit, complete: fakeModel(), executor: fakeExecutor(calls) });

  assert.ok(result.answer.length > 0);
  assert.equal(result.run.mode, 'deep');
  // Branches share one ledger, so numbering is a single sequence across them
  // rather than each branch restarting at [1].
  const ns = result.sources.map((s) => s.n);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
  assert.equal(new Set(ns).size, ns.length, 'no source number is used twice');
});

test('one branch failing does not take the whole run down', async () => {
  // Three parallel branches against a live web: one of them failing is the
  // normal case, not the exceptional one. A deep search that aborts because a
  // single sub-question went wrong wastes everything the others found.
  const { emit } = collect();
  const calls = [];
  const model = fakeModel({
    onBranch: (branch) => {
      if (branch === 'q2') throw new Error('provider exploded on this branch');
      return null;
    },
  });

  const result = await run({ emit, complete: model, executor: fakeExecutor(calls) });
  assert.ok(result.answer.length > 0, 'the run still answered');
  assert.ok(calls.length >= 2, 'the surviving branches still did their work');
});

test('the run is recorded with its phases, so a trace can be reconstructed', async () => {
  const { emit } = collect();
  const calls = [];
  const { run: record } = await run({ emit, complete: fakeModel(), executor: fakeExecutor(calls) });

  const phases = record.phases.map((p) => p.name);
  assert.ok(phases.includes('plan'), 'planning is a phase of its own');
  assert.ok(phases.includes('research'));
  assert.ok(phases.includes('synthesis'));
  assert.equal(typeof record.latency_ms, 'number');
});

test('deep never silently becomes quick', async () => {
  // The two are separate code paths on purpose. A deep run that quietly
  // degraded would bill like deep and answer like quick.
  const { emit } = collect();
  const calls = [];
  const { run: record } = await run({ emit, complete: fakeModel(), executor: fakeExecutor(calls) });
  assert.equal(record.mode, 'deep');
});

/* ------------------------------------------------ the plan a run acts on */

const VALID_PLAN_JSON = JSON.stringify({
  interpretation: 'three angles',
  sub_questions: [
    { question: 'which benchmarks measure this effect', why: 'primary evidence' },
    { question: 'what do controlled studies report', why: 'strength of the evidence' },
    { question: 'where does the effect fail to appear', why: 'limits' },
  ],
});

/** A model whose planner response is scripted; branches and synthesis behave normally. */
function modelWithPlanner(plannerResponses) {
  let planCalls = 0;
  const base = fakeModel();
  const fn = async (params) => {
    if (params.purpose === 'plan' || params.purpose === 'plan_repair') {
      const next = plannerResponses[Math.min(planCalls, plannerResponses.length - 1)];
      planCalls += 1;
      if (typeof next === 'function') return next();
      return { content: [{ type: 'text', text: next }], stop_reason: 'end_turn', usage: {} };
    }
    return base(params);
  };
  fn.planCalls = () => planCalls;
  return fn;
}

const planFrom = (events) => events.find((e) => e.event === 'plan')?.data;

test('a valid plan is used as the model gave it, and marked as the model’s', async () => {
  const { emit, events } = collect();
  const calls = [];
  await run({ emit, complete: modelWithPlanner([VALID_PLAN_JSON]), executor: fakeExecutor(calls) });
  const plan = planFrom(events);
  assert.equal(plan.sub_questions.length, 3);
  assert.equal(plan.origin, 'model');
  assert.equal(plan.degraded, false);
});

test('an unusable plan is repaired once, and the repair is recorded as a repair', async () => {
  const { emit, events } = collect();
  const calls = [];
  const model = modelWithPlanner(['not json at all', VALID_PLAN_JSON]);
  await run({ emit, complete: model, executor: fakeExecutor(calls) });

  assert.equal(model.planCalls(), 2, 'it tried again rather than giving up or looping');
  const plan = planFrom(events);
  assert.equal(plan.origin, 'repair');
  assert.equal(plan.sub_questions.length, 3);
});

test('a planner that fails twice falls back, and the run says so', async () => {
  // The important half is the second assertion: a fallback that reported itself
  // as a model plan would hide the only thing worth knowing about the run.
  const { emit, events } = collect();
  const calls = [];
  const result = await run({ emit, complete: modelWithPlanner(['{"sub_questions": []}', 'still not a plan']), executor: fakeExecutor(calls) });

  const plan = planFrom(events);
  assert.equal(plan.origin, 'fallback');
  assert.equal(plan.degraded, true);
  assert.ok(plan.sub_questions.length >= 3, 'and it still meets the floor the gate measures');
  assert.ok(result.answer.length > 0, 'the run answered anyway');
});

test('a one-question plan never reaches the branches', async () => {
  const { emit, events } = collect();
  const calls = [];
  const oneQuestion = JSON.stringify({ sub_questions: [{ question: 'just the one thing' }] });
  await run({ emit, complete: modelWithPlanner([oneQuestion, oneQuestion]), executor: fakeExecutor(calls) });

  const plan = planFrom(events);
  assert.ok(plan.sub_questions.length >= 3, 'the floor holds even when the planner insists');
  assert.equal(plan.origin, 'fallback');
});

test('a planner that hangs is treated as a planner that failed', async () => {
  // Planning is a deep run's first paint: nothing is shown until it lands, so
  // waiting indefinitely for it is indistinguishable from being broken.
  const { emit, events } = collect();
  const calls = [];
  const hangs = () =>
    new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 30));

  const started = Date.now();
  const result = await run({ emit, complete: modelWithPlanner([hangs, hangs]), executor: fakeExecutor(calls) });
  assert.ok(Date.now() - started < 8000, 'it did not wait out the whole run budget');
  assert.equal(planFrom(events).origin, 'fallback');
  assert.ok(result.answer.length > 0);
});

test('the plan is emitted before any retrieval, whatever its origin', async () => {
  for (const script of [[VALID_PLAN_JSON], ['garbage', 'more garbage']]) {
    const { emit, events, names } = collect();
    const calls = [];
    await run({ emit, complete: modelWithPlanner(script), executor: fakeExecutor(calls) });
    const planAt = names().indexOf('plan');
    const firstTool = names().indexOf('tool_call');
    assert.ok(planAt >= 0, 'a plan was emitted');
    assert.ok(firstTool === -1 || planAt < firstTool, 'and it came before retrieval started');
  }
});
