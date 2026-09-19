import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A Deep answer has to reach the reader, not just the database.
 *
 * Measured on the deployment: a Deep run stored a 7191-character answer, emitted
 * `plan`, `trace`, `sources` and `done`, and sent **zero** `token` frames.
 * `ttftMs` equalled `latencyMs` because no first token was ever marked. Quick
 * streamed 96 frames for the same deployment and commit, and the same defect was
 * present on the commit before this phase's work, so it was not a regression -
 * it had simply never been checked.
 *
 * The cause was one default:
 *
 *   complete: completeFn = complete,                        // non-streaming
 *   ...
 *   ...(completeFn ? { streamComplete: completeFn } : {}),  // therefore always
 *
 * The guard reads as "only when a test injected one", and the comment beside it
 * says production passes neither - but `completeFn` defaults to the imported
 * non-streaming `complete`, so it is never falsy. Production overrode
 * synthesis's streaming function with one that cannot stream. It returns a
 * finished message, so the answer was correct, stored, and invisible.
 *
 * These drive the real orchestration. The fake below is deliberately
 * non-streaming - it is what production's `complete` is - so the first test
 * fails on the old code the way the deployment did.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deepstream-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { runDeepQuery } = await import('../src/agent/core/deep.js');
const { runQuickQuery } = await import('../src/agent/core/quick.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

const ANSWER = 'Reciprocal rank fusion sums one over k plus rank across lists [1]. It needs no score calibration [1].';
const body = 'Reciprocal rank fusion combines ranked lists by summing one over k plus rank, which needs no score calibration. '.repeat(5);

const PLAN = {
  interpretation: 'a multi-part question',
  sub_questions: [
    { id: 'q1', question: 'how ranking fusion combines two ordered candidate lists', why: 'because' },
    { id: 'q2', question: 'what latency cost a reranking stage adds to retrieval', why: 'because' },
    { id: 'q3', question: 'which chunk size preserves citation precision in documents', why: 'because' },
  ],
};

const fetchPage = async (url) => ({
  ok: true, url, final_url: url, status: 200, title: `page ${url}`,
  text: body, fetched_at: new Date().toISOString(), duration_ms: 2, timings: {},
});
const webSearch = async (query) => ({
  results: [{ url: `https://x-${encodeURIComponent(query).slice(0, 10)}.test/a`, title: query, snippet: 'lead' }],
  provider: 'stub', cached: false,
});

/** Production's `complete`: returns a finished message, never streams. */
function nonStreamingModel() {
  const seen = new Map();
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const b = purpose.slice('research:'.length);
      const n = (seen.get(b) ?? 0) + 1;
      seen.set(b, n);
      if (n === 1) return { content: [{ type: 'tool_use', id: `f${b}`, name: 'fetch_page', input: { url: `https://read-${b}.test/a` } }], stop_reason: 'tool_use', usage: {} };
      return { content: [{ type: 'text', text: `notes ${b}` }], stop_reason: 'end_turn', usage: {} };
    }
    // Synthesis: a finished message and no onText, exactly like `complete`.
    return { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: {} };
  };
}

/** A streaming synthesis function, the shape `streamComplete` has. */
function streamingSynthesis(text = ANSWER) {
  return async (params) => {
    for (const piece of text.match(/.{1,12}/g) || []) params.onText?.(piece);
    // A real synthesis keeps going after its first token; without some duration
    // here ttft and latency both round to the same millisecond and the ordering
    // cannot be observed at all.
    await new Promise((r) => setTimeout(r, 25));
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} };
  };
}

async function runDeep(over = {}) {
  const frames = [];
  const mapped = contractStream({ send: (event, data) => frames.push({ event, data }), depth: 'deep', answerId: 'ans_s' });
  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_stream_${Math.random().toString(36).slice(2, 8)}`,
    complete: nonStreamingModel(),
    streamComplete: streamingSynthesis(),
    webSearch,
    fetchPage,
    emit: (event, data) => mapped(event, data),
    ...over,
  });
  const at = (name) => frames.findIndex((f) => f.event === name);
  return {
    result, frames, at,
    tokens: frames.filter((f) => f.event === 'token').map((f) => f.data.text),
    done: frames.find((f) => f.event === 'done')?.data,
  };
}

/* ------------------------------------------------------------ the defect */

test('a Deep run sends at least one token before done', async () => {
  const { tokens, at } = await runDeep();
  assert.ok(tokens.length > 0, 'Deep sent no token frames at all - the answer never reached the reader');
  assert.ok(at('token') < at('done'), 'tokens must arrive before the run is declared done');
});

test('the streamed text is the answer that was stored, after the same normaliser', async () => {
  // Not byte equality: synthesis runs `normalizeAnswerStyle` over the answer
  // before persisting it, so the stored text legitimately differs from the raw
  // deltas. Measured on the deployment, that is 4 to 8 characters on a ~6000
  // character answer. Comparing through the production normaliser is the claim
  // that can honestly be made - the reader saw the same answer, not the same
  // bytes.
  const { normalizeAnswerStyle } = await import('../src/agent/core/style.js');
  const { tokens, result } = await runDeep();
  assert.ok(tokens.length > 0, 'something streamed');
  // It returns { text, changed, replaced }, not a string.
  assert.equal(
    normalizeAnswerStyle(tokens.join('')).text.trim(),
    normalizeAnswerStyle(result.answer).text.trim(),
    'the streamed answer and the stored answer differ by more than normalisation',
  );
});

test('sources arrive before the first token', async () => {
  const { at } = await runDeep();
  assert.notEqual(at('sources'), -1, 'sources were sent');
  assert.ok(at('sources') < at('token'), 'citation chips must exist before the text that refers to them');
});

test('ttft is earlier than the total latency for a multi-token answer', async () => {
  const { done, tokens } = await runDeep();
  assert.ok(tokens.length > 1, 'a multi-token answer');
  assert.ok(done.ttftMs > 0, 'a first token was timed');
  assert.ok(done.ttftMs < done.latencyMs, `ttft ${done.ttftMs}ms is not earlier than latency ${done.latencyMs}ms`);
});

test('an injected streaming synthesis is still honoured', async () => {
  // The seam has to keep working: a test that supplies its own streaming
  // function must see its deltas, not the default.
  const { tokens } = await runDeep({ streamComplete: streamingSynthesis('Alpha beta gamma [1].') });
  assert.equal(tokens.join(''), 'Alpha beta gamma [1].');
});

test('Quick streaming is unchanged', () => {
  // `runQuickQuery` takes no model injection, so it cannot be driven offline -
  // which is itself why Quick never had this defect: with nothing to override
  // synthesis, it always used the real streaming function. The property under
  // test is that it still passes no override.
  const quick = fs.readFileSync(new URL('../src/agent/core/quick.js', import.meta.url), 'utf8');
  const call = quick.slice(quick.indexOf('synthesizeAnswer({'), quick.indexOf('});', quick.indexOf('synthesizeAnswer({')));
  assert.ok(!/streamComplete/.test(call), 'Quick must not override synthesis streaming');
  assert.match(call, /emit,/, 'and still passes emit, which is what carries the tokens');
});

test('production defaults synthesis to the streaming function', () => {
  // The behavioural tests above inject a streaming fake, so they cannot see the
  // defect on their own: it was the *default* that was wrong. Both halves are
  // pinned here - the injection default must be null, and the override must be
  // conditional on something having been injected.
  const src = fs.readFileSync(new URL('../src/agent/core/deep.js', import.meta.url), 'utf8');
  assert.match(src, /complete: completeFn = null,/, 'complete must not default to the non-streaming function');
  assert.ok(
    !/\.\.\.\(completeFn \? \{ streamComplete: completeFn \} : \{\}\)/.test(src),
    'synthesis must not be overridden by a default-populated completeFn',
  );
  assert.match(src, /streamComplete: streamFn = null,/, 'synthesis has its own injection seam');
});

test('both entry points reach synthesis through the same seam', async () => {
  // The Vercel function and the two-process gateway mount the same router, so
  // the callback path is shared by construction. Pinned because a divergence
  // between those two copies is what made an earlier defect deploy-only.
  const api = fs.readFileSync(new URL('../api/index.js', import.meta.url), 'utf8');
  const gw = fs.readFileSync(new URL('../src/gateway/server.js', import.meta.url), 'utf8');
  for (const [name, src] of [['api/index.js', api], ['gateway/server.js', gw]]) {
    assert.match(src, /contractRouter/, `${name} mounts the contract router rather than its own ask path`);
  }
  const route = fs.readFileSync(new URL('../src/agent/routes/contract.js', import.meta.url), 'utf8');
  assert.match(route, /const run = depth === 'deep' \? runDeepQuery : runQuickQuery;/, 'one call site for both depths');
});
