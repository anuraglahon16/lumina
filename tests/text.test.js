import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A request lost to half a character.
 *
 * `String.prototype.slice` counts UTF-16 code units and an emoji is two of
 * them, so truncating page text can leave a lone surrogate. That string is
 * legal in JavaScript, serialises to `"\ud83d"`, and the Anthropic API rejects
 * the whole request:
 *
 *   400 invalid_request_error — "The request body is not valid JSON:
 *   no low surrogate in string: line 1 column 53976"
 *
 * Nine of ten runs in one benchmark probe failed exactly this way. The user
 * loses the answer because a page they never chose had an emoji at an offset
 * nobody picked.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-text-'));
process.env.MONGODB_URI = '';

const { safeSlice, stripLoneSurrogates } = await import('../src/shared/text.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');

// One emoji: two code units, one character.
const EMOJI = '\u{1F600}';

test('an emoji is two code units, which is the whole problem', () => {
  assert.equal(EMOJI.length, 2);
  assert.equal([...EMOJI].length, 1);
});

test('slicing through a surrogate pair produces text the API rejects', () => {
  const text = `abc${EMOJI}def`;
  const naive = text.slice(0, 4);
  // The lone high surrogate survives a plain slice...
  assert.equal(naive.length, 4);
  assert.ok(/[\uD800-\uDBFF]/.test(naive.at(-1)), 'and the last unit is half a character');
  // ...and JSON.stringify happily emits it, which is what reaches the provider.
  assert.match(JSON.stringify(naive), /\\ud83d/i);
});

test('safeSlice stops before the pair rather than through it', () => {
  const text = `abc${EMOJI}def`;
  const cut = safeSlice(text, 4);
  assert.equal(cut, 'abc', 'one character short beats half a character');
  assert.ok(!/[\uD800-\uDFFF]/.test(cut));
});

test('safeSlice keeps a pair that fits', () => {
  assert.equal(safeSlice(`abc${EMOJI}def`, 5), `abc${EMOJI}`);
});

test('safeSlice is the identity when nothing needs cutting', () => {
  assert.equal(safeSlice('plain text', 100), 'plain text');
  assert.equal(safeSlice(`with ${EMOJI} emoji`, 999), `with ${EMOJI} emoji`);
});

test('stripLoneSurrogates removes orphans and leaves real characters', () => {
  assert.equal(stripLoneSurrogates(`ok\uD83Dhere`), 'okhere');
  assert.equal(stripLoneSurrogates(`ok\uDE00here`), 'okhere', 'a low surrogate with no high is also an orphan');
  assert.equal(stripLoneSurrogates(`keep ${EMOJI} me`), `keep ${EMOJI} me`);
});

test('degenerate inputs do not throw', () => {
  for (const v of [null, undefined, '', 0]) {
    assert.doesNotThrow(() => safeSlice(v, 10));
    assert.doesNotThrow(() => stripLoneSurrogates(v));
  }
  assert.equal(safeSlice(null, 10), '');
});

/* ------------------------------------------- through the pieces that truncate */

const page = (text) => ({ ok: true, url: 'https://example.test/p', title: 'T', text, fetched_at: new Date().toISOString() });

test('a source snippet is never cut through a character', () => {
  // The snippet is the first 400 code units of page text. Place an emoji so the
  // boundary lands inside it.
  const text = `${'a'.repeat(399)}${EMOJI}${'b'.repeat(200)}`;
  const ledger = new EvidenceLedger();
  ledger.addWebSource(page(text));

  const { snippet } = ledger.sources[0];
  assert.ok(snippet.length <= 400);
  assert.ok(!/[\uD800-\uDFFF]/.test(snippet), 'no half characters reach the source list');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ snippet })));
});

test('the prompt a source renders into carries no lone surrogate', () => {
  // The per-source cap in renderForPrompt is the other place page text is cut,
  // and it is the one whose output goes straight into the request body.
  const filler = 'This paragraph is long enough to survive the paragraph filter and push the boundary along. '.repeat(60);
  const ledger = new EvidenceLedger();
  ledger.restoreWebSource({
    n: 1,
    url: 'https://example.test/p',
    title: 'T',
    passages: [`${filler}${EMOJI}${filler}`],
  });

  const rendered = String(ledger.renderForPrompt({ query: 'paragraph boundary' }));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rendered), 'the prompt is clean');
  assert.doesNotThrow(() => JSON.stringify({ content: rendered }), 'and serialises');
});
