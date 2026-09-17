import test from 'node:test';
import assert from 'node:assert/strict';
import { contractStream, __testing } from '../src/gateway/contract/events.js';

/**
 * The stream the grader parses.
 *
 * The provided UI validates every frame against a closed zod union, so a field
 * with the wrong name is not a cosmetic difference — it is a run that renders as
 * an error. These tests are the contract restated in assertions, because the
 * schemas themselves live in `packages/contract/`, which is read-only here.
 */

function collect(opts = {}) {
  const frames = [];
  const emit = contractStream({ send: (event, data) => frames.push({ event, data }), depth: 'quick', answerId: 'ans_1', ...opts });
  return { frames, emit, names: () => frames.map((f) => f.event) };
}

const source = (over = {}) => ({ n: 1, type: 'web', title: 'A', url: 'https://example.com/a', snippet: 'fetched text', ...over });

test('a quick run streams trace, then sources, then tokens, then done', () => {
  const { emit, names } = collect();
  emit('tool_call', { tool: 'web_search', input: { query: 'x' } });
  emit('tool_result', { tool: 'web_search', ok: true, duration_ms: 12, summary: '6 results' });
  emit('sources', { sources: [source()] });
  emit('token', { text: 'Hello' });
  emit('done', { latency_ms: 100, ttft_ms: 40, model: 'claude-sonnet-5', tokens: { input: 5, output: 7 }, cost_usd: 0.01, termination_reason: 'completed' });
  assert.deepEqual(names(), ['trace', 'sources', 'token', 'done']);
});

test('a token before sources is refused rather than sent', () => {
  // The UI renders citation chips as text arrives. Text first means chips that
  // point at nothing, which is the one ordering rule the contract will not bend.
  const { emit } = collect();
  assert.throws(() => emit('token', { text: 'too early' }), /before the sources event/);
});

test('a failed trace step always carries an error string', () => {
  // The schema refuses ok:false with an empty error: a failure indistinguishable
  // from an empty result is exactly the bug the contract exists to prevent.
  const { frames, emit } = collect();
  emit('tool_call', { tool: 'fetch_page', input: { url: 'https://x' } });
  emit('tool_result', { tool: 'fetch_page', ok: false, duration_ms: 5 });
  const [trace] = frames;
  assert.equal(trace.data.ok, false);
  assert.ok(trace.data.error && trace.data.error.length > 0);
});

test('trace steps are numbered from one and carry the call’s own input', () => {
  const { frames, emit } = collect();
  emit('tool_call', { tool: 'web_search', input: { query: 'first' } });
  emit('tool_result', { tool: 'web_search', ok: true, duration_ms: 1 });
  emit('tool_call', { tool: 'fetch_page', input: { url: 'https://b' } });
  emit('tool_result', { tool: 'fetch_page', ok: true, duration_ms: 2 });
  assert.deepEqual(frames.map((f) => f.data.step), [1, 2]);
  assert.deepEqual(frames[0].data.input, { query: 'first' });
  assert.deepEqual(frames[1].data.input, { url: 'https://b' });
});

test('engine events with no counterpart are dropped, not passed through', () => {
  // The UI parses a closed union, so an unknown event name is a validation
  // error rather than something it politely ignores.
  const { names, emit } = collect();
  for (const e of ['context', 'iteration', 'reasoning', 'capped', 'citations', 'memory_used', 'branch_start', 'sweep_done']) {
    emit(e, {});
  }
  assert.deepEqual(names(), []);
});

test('a web source keeps its url and a doc source its id', () => {
  const web = __testing.toContractSource(source());
  assert.equal(web.kind, 'web');
  assert.equal(web.url, 'https://example.com/a');
  assert.ok(!('docId' in web));

  const doc = __testing.toContractSource({ n: 2, type: 'document', title: 'Report', doc_id: 'doc_7', snippet: 'chunk', locator: { page: 3 } });
  assert.equal(doc.kind, 'doc');
  assert.equal(doc.docId, 'doc_7');
  assert.deepEqual(doc.locator, { page: 3 });
  assert.ok(!('url' in doc));
});

test('a snippet is never empty, because the grounding check reads it', () => {
  const s = __testing.toContractSource({ n: 1, type: 'web', title: 'Titled', url: 'https://x', snippet: '   ' });
  assert.ok(s.snippet.trim().length > 0);
});

test('capping is reported as an honest partial, not as success or failure', () => {
  assert.equal(__testing.toTerminated('completed'), 'done');
  assert.equal(__testing.toTerminated('sufficient_evidence'), 'done');
  assert.equal(__testing.toTerminated('max_tool_calls_reached'), 'cap');
  assert.equal(__testing.toTerminated('wall_clock_exceeded'), 'cap');
  assert.equal(__testing.toTerminated('max_tokens'), 'cap');
  assert.equal(__testing.toTerminated('completed', 'error'), 'error');
});

test('searchCached is true only when every search was a hit', () => {
  const run = (cachedFlags) => {
    const { frames, emit } = collect();
    for (const cached of cachedFlags) {
      emit('tool_call', { tool: 'web_search', input: {} });
      emit('tool_result', { tool: 'web_search', ok: true, cached, duration_ms: 1 });
    }
    emit('sources', { sources: [source()] });
    emit('done', { tokens: {}, model: 'm' });
    return frames.at(-1).data.searchCached;
  };
  assert.equal(run([true, true]), true);
  assert.equal(run([true, false]), false, 'one live search means the answer was not served from cache');
  assert.equal(run([]), false, 'no searches at all is not "every search was cached"');
});

test('a deep run streams its plan first and reports the count when done', () => {
  const { frames, names, emit } = collect({ depth: 'deep' });
  emit('plan', { interpretation: 'why', sub_questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }] });
  emit('sources', { sources: [source()] });
  emit('done', { tokens: {}, model: 'm', termination_reason: 'completed' });
  assert.equal(names()[0], 'plan');
  assert.deepEqual(frames[0].data.subQuestions.map((q) => q.i), [1, 2, 3]);
  assert.equal(frames.at(-1).data.subQuestions, 3);
  assert.equal(frames.at(-1).data.depth, 'deep');
});

test('a one-question plan is not streamed, because the schema forbids it', () => {
  // "A plan with two sub-questions is a quick search with extra steps" — the
  // contract's own words, and one is worse.
  const { names, emit } = collect({ depth: 'deep' });
  emit('plan', { sub_questions: [{ question: 'only one' }] });
  assert.deepEqual(names(), []);
});

test('done carries the shape the benchmark reads', () => {
  const { frames, emit } = collect();
  emit('sources', { sources: [source()] });
  emit('done', {
    latency_ms: 1234, ttft_ms: 567, model: 'claude-sonnet-5',
    tokens: { input: 10, output: 20 }, cost_usd: 0.0321, termination_reason: 'completed',
  });
  const d = frames.at(-1).data;
  assert.equal(d.answerId, 'ans_1');
  assert.equal(d.latencyMs, 1234);
  assert.equal(d.ttftMs, 567);
  assert.deepEqual(d.tokens, { in: 10, out: 20 });
  assert.equal(d.costUsd, 0.0321);
  assert.equal(d.depth, 'quick');
  assert.ok(!('subQuestions' in d), 'a quick run has no plan to report');
});

test('a run that fails before any source still sends sources before done', () => {
  // bench.mjs asserts the ordering on every answer it receives, including the
  // ones that went wrong.
  const { names, emit } = collect();
  emit('done', { tokens: {}, model: 'm', status: 'error' });
  assert.deepEqual(names(), ['sources', 'done']);
  assert.equal(names().indexOf('sources') < names().indexOf('done'), true);
});
