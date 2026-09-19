import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchLoop } from '../src/agent/core/researchLoop.js';
import { Budget } from '../src/agent/core/budget.js';

/**
 * The research loop's control flow, with the model and the tools faked.
 *
 * What is worth pinning here is not what the model says but what the harness
 * does with it: when the loop stops, what it calls that stop, and what it
 * refuses to accept as finished. Those are the behaviours that failed in
 * practice, and each one failed quietly: a run that read nothing still produced
 * a confident "no evidence available" for an answerable question.
 */

/** A model that returns a scripted sequence of turns. */
function scriptedModel(turns) {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
    const turn = turns[Math.min(calls.length - 1, turns.length - 1)];
    return typeof turn === 'function' ? turn(calls.length) : turn;
  };
  fn.calls = calls;
  return fn;
}

const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const useTool = (name, input = {}, id = `t${Math.random()}`) => ({
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
});

/** A ledger stub: only what the loop actually reads. */
const ledgerWith = ({ sources = 0, candidates = 0 } = {}) => ({
  citable: Array.from({ length: sources }, (_, i) => ({ n: i + 1 })),
  candidates: new Map(Array.from({ length: candidates }, (_, i) => [`u${i}`, {}])),
});

const budget = (over = {}) =>
  new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60_000, ...over });

const okTool = async () => ({ ok: true, content: 'result' });

const run = (opts) =>
  runResearchLoop({
    system: 's',
    userMessage: 'u',
    ledger: ledgerWith(),
    budget: budget(),
    executor: okTool,
    hasDocuments: false,
    ...opts,
  });

test('a model that calls no tools ends the loop as completed', async () => {
  const model = scriptedModel([say('done')]);
  const result = await run({ complete: model });
  assert.equal(result.termination_reason, 'completed');
  assert.equal(result.capped, false);
  assert.equal(model.calls.length, 1);
});

test('hitting max_tokens is reported as such, not as completion', async () => {
  // A truncated turn is not a finished one; conflating them would let a cut-off
  // run present itself as complete.
  const model = scriptedModel([{ content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens' }]);
  const result = await run({ complete: model });
  assert.equal(result.termination_reason, 'max_tokens');
  assert.equal(result.capped, true);
});

test('the iteration limit stops the loop and names itself', async () => {
  const model = scriptedModel([useTool('web_search', { query: 'x' })]);
  const result = await run({ complete: model, budget: budget({ maxIterations: 2 }) });
  assert.equal(result.termination_reason, 'max_iterations_reached');
  // Named, but not capped: the loop ran the iterations it was allocated and
  // stopped. Nothing was refused, so nothing was cut short.
  assert.equal(result.capped, false, 'an allocation spent in full is a normal finish');
  assert.equal(model.calls.length, 2, 'it stops at the limit rather than one turn past it');
});

test('the budget is checked before the model is called, not after', async () => {
  // Checking afterwards would spend a call to discover there was nothing left
  // to spend, which on a deep run means five wasted calls.
  const spent = budget({ maxIterations: 0 });
  const model = scriptedModel([say('never reached')]);
  const result = await run({ complete: model, budget: spent });
  assert.equal(model.calls.length, 0, 'an exhausted budget must not reach the model at all');
  assert.equal(result.termination_reason, 'max_iterations_reached');
});

test('a disconnected client ends the run with its own reason', async () => {
  const model = scriptedModel([useTool('web_search')]);
  const result = await run({ complete: model, signal: { aborted: true } });
  assert.equal(result.termination_reason, 'client_disconnected');
  assert.equal(result.capped, true);
});

test('pause_turn continues the loop rather than ending it', async () => {
  const model = scriptedModel([
    { content: [{ type: 'text', text: 'thinking' }], stop_reason: 'pause_turn' },
    say('now done'),
  ]);
  const result = await run({ complete: model });
  assert.equal(result.termination_reason, 'completed');
  assert.equal(model.calls.length, 2, 'a pause is resumed, not treated as an answer');
});

test('parallel tool calls come back in a single user turn', async () => {
  // Splitting them across turns is accepted by the API and then quietly trains
  // the model to stop making parallel calls.
  const model = scriptedModel([
    {
      content: [
        { type: 'tool_use', id: 'a', name: 'web_search', input: { query: '1' } },
        { type: 'tool_use', id: 'b', name: 'web_search', input: { query: '2' } },
      ],
      stop_reason: 'tool_use',
    },
    say('done'),
  ]);
  await run({ complete: model });

  const second = model.calls[1].messages;
  const results = second.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.equal(results.length, 1, 'both results belong to one user message');
  assert.equal(results[0].content.length, 2);
  assert.deepEqual(results[0].content.map((c) => c.tool_use_id).sort(), ['a', 'b']);
});

test('a failed tool is returned to the model as an error result, not dropped', async () => {
  const model = scriptedModel([useTool('fetch_page', { url: 'https://x' }, 'f1'), say('done')]);
  await run({ complete: model, executor: async () => ({ ok: false, content: 'Could not read it' }) });
  const block = model.calls[1].messages.at(-1).content[0];
  assert.equal(block.is_error, true, 'the model must be told the call failed');
  assert.match(block.content, /Could not read/);
});

/* ------------------------------------------- refusing to finish unread */

test('finishing with candidates found but nothing read is treated as unfinished', async () => {
  // The bug this prevents: a search snippet contains the answer, the model is
  // satisfied and stops, the ledger refuses to make snippets citable, and the
  // run honestly reports no evidence for an answerable question.
  const model = scriptedModel([say('I already know this'), useTool('fetch_page', { url: 'https://x' }), say('done')]);
  const result = await run({ complete: model, ledger: ledgerWith({ sources: 0, candidates: 6 }) });

  assert.ok(model.calls.length > 1, 'the loop pushed back instead of accepting the first stop');
  const nudge = model.calls[1].messages.at(-1);
  assert.match(JSON.stringify(nudge), /not read any page|fetch_page/i);
  assert.equal(result.termination_reason, 'completed');
});

test('a run that read something is allowed to finish immediately', async () => {
  const model = scriptedModel([say('done')]);
  await run({ complete: model, ledger: ledgerWith({ sources: 2, candidates: 6 }) });
  assert.equal(model.calls.length, 1, 'having evidence, the loop does not argue');
});

test('a run with nothing to read is allowed to finish', async () => {
  // No candidates means the search genuinely found nothing, which is a real
  // answer of its own. Nudging here would burn budget for no possible gain.
  const model = scriptedModel([say('nothing out there')]);
  await run({ complete: model, ledger: ledgerWith({ sources: 0, candidates: 0 }) });
  assert.equal(model.calls.length, 1);
});

test('the nudge is bounded, so a model that insists is not argued with forever', async () => {
  const model = scriptedModel([say('still nothing')]);
  const result = await run({ complete: model, ledger: ledgerWith({ sources: 0, candidates: 3 }) });
  assert.ok(model.calls.length <= 3, `expected at most 1 stop + 2 nudges, got ${model.calls.length}`);
  assert.equal(result.termination_reason, 'completed');
});

test('no nudge is issued when the fetch budget is already spent', async () => {
  // Asking for a fetch that cannot happen wastes a model call to be told no.
  const spent = budget({ maxFetches: 0 });
  const model = scriptedModel([say('done')]);
  await run({ complete: model, budget: spent, ledger: ledgerWith({ sources: 0, candidates: 5 }) });
  assert.equal(model.calls.length, 1);
});

/* --------------------------------- the wall clock bounds calls, not just gaps */

test('a model call that outlives the wall clock ends the run as wall_clock_exceeded', async () => {
  // The bug this pins: the budget was only consulted between iterations, so a
  // single call that hung ran as long as it liked inside it. One research call
  // took 773 seconds against a 60-second budget and the run still reported
  // `completed`. A limit enforced only between calls is not a limit.
  const hangs = async ({ signal }) => {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      // Never resolves on its own: only the deadline can end this.
    });
  };

  const started = Date.now();
  const result = await run({ complete: hangs, budget: budget({ wallClockMs: 150 }) });
  const elapsed = Date.now() - started;

  assert.equal(result.termination_reason, 'wall_clock_exceeded');
  assert.equal(result.capped, true);
  assert.ok(elapsed < 3000, `the loop must not wait for a call that never returns (waited ${elapsed}ms)`);
});

test('the loop passes a signal to the model at all', async () => {
  // Without this the deadline has nothing to act on, and the test above would
  // pass for the wrong reason if the loop simply stopped calling the model.
  const model = scriptedModel([say('done')]);
  await run({ complete: model });
  assert.ok(model.calls[0].signal, 'every research call carries a cancellation signal');
});

test('a client disconnect mid-call is not reported as a spent wall clock', async () => {
  // Both arrive as an abort; the two are told apart by whether the budget's own
  // clock ran out. Confusing them would tell the user the research was cut
  // short when in fact they navigated away.
  const controller = new AbortController();
  const hangs = async ({ signal }) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      setTimeout(() => controller.abort(), 20);
    });

  const result = await run({ complete: hangs, budget: budget({ wallClockMs: 60_000 }), signal: controller.signal });
  assert.equal(result.termination_reason, 'client_disconnected');
});

test('an error that is not an abort still propagates', async () => {
  // The abort handling must not become a catch-all that swallows real faults.
  const boom = async () => {
    throw new Error('provider exploded');
  };
  await assert.rejects(() => run({ complete: boom }), /provider exploded/);
});

/* ------------------------------------------ stopping once there is enough read */

test('the loop stops once it has read enough, without asking the model again', async () => {
  // The turn this removes produced no tool call and no text anyone reads: the
  // model agreeing it was finished, for three to five seconds of the time
  // before the first answer token.
  const ledger = ledgerWith({ sources: 0, candidates: 4 });
  const model = scriptedModel([
    useTool('fetch_page', { url: 'https://a' }),
    say('should never be reached'),
  ]);
  const result = await run({
    complete: model,
    ledger,
    budget: budget({ sufficientSources: 1 }),
    // The executor is what puts a source in the ledger in the real loop.
    executor: async () => {
      ledger.citable.push({ n: ledger.citable.length + 1 });
      return { ok: true, content: 'page text' };
    },
  });

  assert.equal(model.calls.length, 1, 'the confirming turn is not spent');
  assert.equal(result.termination_reason, 'sufficient_evidence');
  assert.equal(result.capped, false, 'this is a stop, not a cap: the run got what it came for');
});

test('a Deep branch is not stopped by what its siblings have read', async () => {
  // Branches share one ledger. Counting its total rather than this loop's own
  // contribution would end a branch that had read nothing at all.
  const ledger = ledgerWith({ sources: 5, candidates: 4 }); // siblings were busy
  const model = scriptedModel([useTool('fetch_page', { url: 'https://a' }), say('done')]);
  const result = await run({
    complete: model,
    ledger,
    branch: 'q2',
    budget: budget({ sufficientSources: 2 }),
    executor: okTool, // this branch adds nothing to the ledger
  });

  assert.ok(model.calls.length > 1, 'the branch keeps working');
  assert.equal(result.termination_reason, 'completed');
});

test('the early stop is off when no threshold is configured', async () => {
  const ledger = ledgerWith({ sources: 0, candidates: 4 });
  const model = scriptedModel([useTool('fetch_page', { url: 'https://a' }), say('done')]);
  const result = await run({
    complete: model,
    ledger,
    budget: budget({ sufficientSources: 0 }),
    executor: async () => {
      ledger.citable.push({ n: ledger.citable.length + 1 });
      return { ok: true, content: 'page text' };
    },
  });
  assert.equal(model.calls.length, 2, 'the model decides when it is finished');
  assert.equal(result.termination_reason, 'completed');
});
