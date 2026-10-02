import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * No citation marker reaches the stream unless its numbers resolve.
 *
 * `benchmark/lib.mjs` builds `answer.text` from the streamed `token` deltas -
 * `out.text += parsed.text` - and the contract has no `answer` event, so nothing
 * can replace what was streamed. `scoreGrounding` then walks every `[n]` in that
 * text and counts one with no matching source as `dangling`, which the gate calls
 * an automatic fail. The post-hoc validator strips such a marker from the STORED
 * answer, which fixes the transcript and not the stream.
 *
 * `sources` is always emitted before the first token, so the valid set is known
 * before any text arrives and the check is exact rather than a heuristic.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-citeguard-'));
process.env.MONGODB_URI = '';

const { contractStream, createCitationGuard } = await import('../src/gateway/contract/events.js');

/** Drive a stream and return the text a client would have received. */
function streamOf(chunks, sourceNumbers = [1, 2, 3]) {
  const sent = [];
  const emit = contractStream({ send: (event, data) => sent.push({ event, data }), depth: 'quick', answerId: 'ans_t', requestId: 'req_t' });
  emit('sources', { sources: sourceNumbers.map((n) => ({ n, type: 'web', title: `S${n}`, url: `https://e.test/${n}`, snippet: 'text' })) });
  for (const c of chunks) emit('token', { text: c });
  emit('done', { latency_ms: 1, tokens: { input: 1, output: 1 } });
  return sent.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
}

/* ---------------- the defect */

test('a dangling marker never reaches the stream', () => {
  const text = streamOf(['The answer [1] and also [9].'], [1, 2, 3]);
  assert.ok(!/\[9\]/.test(text), `[9] has no source and must not be streamed: ${JSON.stringify(text)}`);
  assert.match(text, /\[1\]/, 'and a valid marker survives');
  assert.equal(text, 'The answer [1] and also .', 'the marker is removed, the prose is not');
});

test('a marker split across frames is still caught', () => {
  // The case a naive per-frame check misses: the bracket spans three deltas.
  const text = streamOf(['The answer [', '9', '] is wrong.'], [1, 2, 3]);
  assert.ok(!/\[9\]/.test(text), `split marker leaked: ${JSON.stringify(text)}`);
  assert.equal(text, 'The answer  is wrong.');
});

test('a valid marker split across frames survives intact', () => {
  const text = streamOf(['See [', '2', '] for detail.'], [1, 2, 3]);
  assert.equal(text, 'See [2] for detail.');
});

test('a multi-reference marker is checked number by number', () => {
  assert.equal(streamOf(['Both [1, 2] agree.'], [1, 2, 3]), 'Both [1, 2] agree.');
  // One bad number invalidates the marker: a partially-wrong citation is wrong.
  const mixed = streamOf(['Both [1, 9] agree.'], [1, 2, 3]);
  assert.ok(!/9/.test(mixed), `a marker containing an unknown number must not stream: ${JSON.stringify(mixed)}`);
});

test('adjacent markers are handled independently', () => {
  assert.equal(streamOf(['Both [1][2] agree.'], [1, 2, 3]), 'Both [1][2] agree.');
  assert.equal(streamOf(['Both [1][9] agree.'], [1, 2, 3]), 'Both [1] agree.');
});

/* ---------------- what must pass through untouched */

test('a bracket that is not citation-shaped passes through unchanged', () => {
  for (const s of [
    'See [the docs](https://e.test/x) for more.',
    'Use arr[i] and map[key] here.',
    'He said "[sic]" in the quote.',
    'A range [1-5] of values.',
    'A decimal [1.5] value.',
    'An empty [] bracket.',
    'Nested [[1]] brackets.',
  ]) {
    assert.equal(streamOf([s], [1, 2, 3]), s, `unchanged: ${s}`);
  }
});

test('a numeric bracket that is not a valid source is stripped even in prose', () => {
  /**
   * The cost of this guard, stated rather than hidden.
   *
   * `benchmark/lib.mjs` extracts citations with `/\[(\d{1,3})\]/g`, which has no
   * notion of context: `arr[0]` is a citation to source 0 as far as the grader is
   * concerned, and source 0 does not exist, so it scores as dangling and fails
   * the run. The guard therefore has to strip it, and an array index written that
   * way loses its subscript.
   *
   * The trade is deliberate: in a citation-grounded research answer a literal
   * `arr[0]` is rare and a hallucinated `[9]` is the real risk, and only one of
   * the two can be allowed through.
   */
  assert.equal(streamOf(['Use arr[0] here.'], [1, 2, 3]), 'Use arr here.');
  // In range and valid, so it stays - the rule is "resolves", not "looks like prose".
  assert.equal(streamOf(['Use arr[1] here.'], [1, 2, 3]), 'Use arr[1] here.');
});

test('an unclosed bracket is flushed rather than held forever', () => {
  // The bound: a fragment that cannot become a citation, or grows too long, goes out.
  assert.equal(streamOf(['A trailing ['], [1, 2, 3]), 'A trailing [', 'held then flushed at done');
  assert.equal(streamOf(['A [12345678901234 long one'], [1, 2, 3]), 'A [12345678901234 long one', 'past the bound');
  assert.equal(streamOf(['Markdown [link text'], [1, 2, 3]), 'Markdown [link text', 'not citation-shaped, never held');
});

test('nothing is lost when the stream ends mid-bracket', () => {
  const text = streamOf(['The answer [1] and [', '2'], [1, 2, 3]);
  // `[2` never closed, so it is not a citation and is released verbatim.
  assert.equal(text, 'The answer [1] and [2');
});

test('the guard is byte-exact on text with no brackets at all', () => {
  const prose = 'A sentence. Another one! A third? Yes — with punctuation, dashes and 42 numbers.';
  assert.equal(streamOf([prose], [1]), prose);
  // And across arbitrary frame boundaries.
  const frames = prose.match(/.{1,7}/g) ?? [];
  assert.equal(streamOf(frames, [1]), prose);
});

/* ---------------- streamed text == stored answer text */

test('the streamed text equals what the validator would store', () => {
  /**
   * The invariant the whole guard exists for. The validator strips a marker
   * whose number has no source; the guard strips the same marker from the
   * stream. Applied to the same draft, both must produce the same text - if the
   * stream were cleaner or dirtier than the transcript, a reader and the grader
   * would be looking at different answers.
   */
  const sources = [1, 2, 3];
  const allowed = new Set(sources);
  const draft = 'First [1]. Second [9]. Third [2, 3]. Fourth [1, 9]. Markdown [a](b). Fifth [3].';

  const streamed = streamOf(draft.match(/.{1,5}/g) ?? [], sources);
  // The validator's rule, applied directly: drop a marker unless every number resolves.
  const stored = draft.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (m, inner) =>
    inner.split(',').every((x) => allowed.has(Number(x.trim()))) ? m : '',
  );
  assert.equal(streamed, stored, 'streamed text and stored text must be identical');
});

/* ---------------- the unit, directly */

test('the guard reports every number it strips', () => {
  const stripped = [];
  const g = createCitationGuard({ allowed: new Set([1, 2]), onStripped: (n) => stripped.push(n) });
  const out = g.push('a [1] b [7] c [2, 8] d') + g.flush();
  assert.equal(out, 'a [1] b  c  d');
  assert.deepEqual(stripped.sort(), [7, 8], 'so an `invalid` count can explain itself');
});

test('the guard holds only a citation-shaped tail', () => {
  const g = createCitationGuard({ allowed: new Set([1]), onStripped: () => {} });
  assert.equal(g.push('text ['), 'text ', 'a bare bracket is held');
  assert.equal(g.push('1]'), '[1]', 'and released once it resolves');
  assert.equal(g.push('tail [x'), 'tail [x', 'a non-numeric bracket is not held');
  assert.equal(g.flush(), '');
});

test('every answer path streams through the same guard', () => {
  // Quick, deep and document answers all emit `token` through contractStream,
  // so one guard covers all three; pinned so a new path cannot bypass it.
  const src = fs.readFileSync(new URL('../src/gateway/contract/events.js', import.meta.url), 'utf8');
  const tokenCase = src.slice(src.indexOf("case 'token':"), src.indexOf("case 'done':"));
  assert.match(tokenCase, /guard\.push\(/, 'the token case goes through the guard');
  assert.ok(!/send\('token', \{ text: data\?\.text \?\? '' \}\)/.test(src), 'and no path sends raw token text');

  const route = fs.readFileSync(new URL('../src/agent/routes/contract.js', import.meta.url), 'utf8');
  assert.match(route, /const run = depth === 'deep' \? runDeepQuery : runQuickQuery;/, 'one call site for both depths');
  // One construction site; the other match is the exported definition itself.
  assert.equal((src.match(/= createCitationGuard\(\{/g) ?? []).length, 1, 'one guard, constructed once per stream');
});
