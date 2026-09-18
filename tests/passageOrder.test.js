import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which half of a page the model gets to read.
 *
 * `renderForPrompt` caps each source at 4500 characters and the pages this
 * system reads run past ten thousand, so more than half of every long source
 * was never shown to the model. Which half survived was decided by extraction
 * order — the order text appears on the page, which has nothing to do with the
 * question.
 *
 * Three questions in a twenty-question replay were answered "the evidence does
 * not cover this" while the text answering them sat in the ledger past the cut.
 * The answers were correct about their prompt. The page's navigation menu made
 * it in and the answer did not.
 *
 * Two things are pinned here. Ordering never adds, drops or alters a passage,
 * because the fix must not become a second way to lose evidence. And a passage
 * that covers the question is never demoted as navigation, whatever it looks
 * like: the borrow-checker answer lives in a comparison table of short
 * unpunctuated lines, which is indistinguishable from a menu by shape alone.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-order-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { reorderPassages, queryCoverage, fragmentRatio, features, ORDERINGS } = await import('../src/agent/core/passageOrder.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');

const QUESTION = 'What does the borrow checker in Rust prevent at compile time?';

const MENU = 'Machine Identity Security: The Definitive Guide\n\nFour Pillars of Machine Identity Architecture\n\nWhat Is Cert-Manager?';
// Verbatim from the e2e0e46 run: the passage that answers the borrow-checker
// question. It is a comparison table rendered as short unpunctuated lines, so
// by shape alone it is indistinguishable from a navigation menu.
const TABLE =
  'Non-deterministic, typically during runtime pauses\n\nPrevents memory errors (use-after-free, dangling pointers, etc.) at compile time\n\n' +
  'Relies on runtime checks to prevent memory errors\n\nMinimal runtime overhead. No background garbage collection processes\n\n' +
  'Can introduce runtime pauses and overhead due to tracing and collection\n\nPredictable memory usage and deallocation timing';
const PROSE = 'The borrow checker is an essential feature of the Rust language and part of what makes Rust what it is. It helps you manage ownership of memory.';

/* --------------------------------------------------- the ranker's features */

test('query coverage counts distinct question terms, not repetitions', () => {
  // A menu repeating the page title six times must not outrank a paragraph
  // that answers the question once.
  const once = queryCoverage('the borrow checker prevents memory errors at compile time', QUESTION);
  const sixTimes = queryCoverage('borrow checker '.repeat(6), QUESTION);
  assert.ok(once > sixTimes, `answering once (${once}) beats repeating the terms (${sixTimes})`);
});

test('a menu is mostly unterminated short lines and a paragraph is not', () => {
  assert.ok(fragmentRatio(MENU) >= 0.6, `menu fragment ratio ${fragmentRatio(MENU)}`);
  assert.ok(fragmentRatio(PROSE) < 0.6, `prose fragment ratio ${fragmentRatio(PROSE)}`);
});

test('shape alone cannot tell a content table from a navigation menu', () => {
  // This is why arm C lost and why nothing shipped depends on it.
  //
  // The borrow-checker answer lives in a comparison table: short lines, no full
  // stops, no digits. Every shape test that catches a navigation menu catches
  // this too, and burying it buries the answer. The coverage guard rescues it
  // only when coverage clears a threshold I picked by hand while looking at
  // these very cases, and this passage sits at 0.5 against a guard of 0.6 -
  // which is to say the guard does not reliably rescue it.
  //
  // Recorded rather than tuned away. Moving the threshold to 0.5 to make this
  // assertion pass would be fitting the rule to the three examples it was
  // derived from, and the honest conclusion is the one the experiment already
  // reached: demote nothing, rank by coverage, ship arm B.
  const table = features(TABLE, QUESTION);
  const menu = features(MENU, QUESTION);

  assert.ok(table.fragment_ratio >= 0.6, 'the content table looks like a menu');
  assert.ok(menu.fragment_ratio >= 0.6, 'and so does the menu');
  assert.equal(table.navigation_like, menu.navigation_like, 'the shape heuristic cannot separate them');

  // What does separate them, and what the shipped ordering uses.
  assert.ok(table.query_coverage > menu.query_coverage, 'coverage does: the table speaks to the question and the menu does not');
});

/* ------------------------------------------------------- reordering itself */

test('reordering never adds, drops or alters a passage', () => {
  // The fix must not become a second way to lose evidence.
  const passages = [MENU, PROSE, TABLE, 'A pointer points at a memory address.'];
  for (const ordering of Object.keys(ORDERINGS)) {
    const ranked = reorderPassages(passages, QUESTION, ordering);
    assert.equal(ranked.length, passages.length, `${ordering} kept every passage`);
    assert.deepEqual([...ranked.map((p) => p.text)].sort(), [...passages].sort(), `${ordering} altered nothing`);
    assert.deepEqual(ranked.map((p) => p.to), [0, 1, 2, 3], `${ordering} numbered the new positions`);
    assert.deepEqual([...ranked.map((p) => p.from)].sort(), [0, 1, 2, 3], `${ordering} recorded every original position`);
  }
});

test('the original ordering is the identity', () => {
  const passages = [MENU, PROSE, TABLE];
  const ranked = reorderPassages(passages, QUESTION, 'original');
  assert.deepEqual(ranked.map((p) => p.from), [0, 1, 2]);
});

test('relevance ordering sinks the menu below everything that answers', () => {
  const ranked = reorderPassages([MENU, PROSE, TABLE], QUESTION, 'relevance');
  assert.equal(ranked.at(-1).text, MENU, 'the menu, which covers none of the question, goes last');
  assert.ok(ranked.slice(0, 2).some((p) => p.text === TABLE), 'and the answer-bearing table is ahead of it');
  // Ties keep the original order, so the ranking is a total order rather than
  // something that shuffles between runs on equal scores.
  const twice = reorderPassages([MENU, PROSE, TABLE], QUESTION, 'relevance');
  assert.deepEqual(twice.map((p) => p.from), ranked.map((p) => p.from), 'and it is deterministic');
});

test('relevance is what renderForPrompt uses, not the navigation heuristic', () => {
  // Arm C, which demoted navigation-looking passages, lost the experiment to
  // arm B, which only counts question coverage: 2 false refusals against 1.
  // `content_first` is kept so the experiment can be re-run, and is not the
  // shipped path. It also carries a hand-chosen threshold, which is a second
  // reason not to ship it on a result it did not win.
  const source = fs.readFileSync(new URL('../src/agent/core/evidence.js', import.meta.url), 'utf8');
  assert.match(source, /reorderPassages\(s\.passages, query, 'relevance'\)/);
});

test('an unknown ordering is refused rather than silently ignored', () => {
  assert.throws(() => reorderPassages([PROSE], QUESTION, 'best'), /unknown ordering/);
});

test('every move is auditable', () => {
  const ranked = reorderPassages([MENU, PROSE, TABLE], QUESTION, 'relevance');
  for (const p of ranked) {
    assert.equal(typeof p.from, 'number');
    assert.equal(typeof p.to, 'number');
    assert.ok(p.features, 'with the features the decision was made from');
    assert.equal(typeof p.features.query_coverage, 'number');
  }
});

/* ------------------------------------------- what actually reaches the model */

const page = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

/** A source whose answer sits past the per-source cap, as the real ones did. */
function buriedAnswerLedger() {
  const filler = 'This section covers unrelated background material about certificate management and adjacent topics. '.repeat(50);
  const ledger = new EvidenceLedger();
  ledger.restoreWebSource({
    n: 1,
    url: 'https://example.test/pinning',
    title: 'Pinning',
    passages: [MENU, filler, 'Certificate pinning effectively breaks this attack lifecycle because the application rejects any certificate that does not match the expected pin.'],
  });
  return ledger;
}

test('without the question, the cap keeps whatever was extracted first', () => {
  // The behaviour that produced three truthful refusals: the answer was in the
  // ledger and not in the prompt.
  const rendered = buriedAnswerLedger().renderForPrompt();
  assert.ok(!rendered.includes('breaks this attack lifecycle'), 'the answer does not reach the model');
  assert.ok(rendered.includes('Machine Identity Security'), 'the navigation menu does');
});

test('with the question, the answer survives the cap', () => {
  const question = 'What does TLS certificate pinning protect against?';
  const rendered = buriedAnswerLedger().renderForPrompt({ query: question });
  assert.ok(rendered.includes('breaks this attack lifecycle'), 'the passage that answers the question is in the prompt');
});

test('the cap still applies, and says what it dropped', () => {
  // Ordering is not a licence to send everything: a Quick request pays for
  // every character of the prompt before its first token.
  const rendered = buriedAnswerLedger().renderForPrompt({ query: 'certificate pinning' });
  assert.ok(rendered.length < 5200, `the per-source cap still holds (${rendered.length} chars)`);
  assert.equal(rendered.dropped_sources.length, 1, 'and the loss is reported rather than silent');
  assert.ok(rendered.dropped_sources[0].dropped > 0);
  assert.equal(rendered.dropped_sources[0].n, 1, 'naming the source it came from');
});

test('reordering does not change what groundedness measures', () => {
  // Scoring uses the whole passage set and is order-independent. If ordering
  // moved the score, the fix would be quietly rewriting the measurement.
  const text = 'Certificate pinning effectively breaks this attack lifecycle because the application rejects any certificate that does not match the expected pin. '.repeat(3);
  const answer = 'Certificate pinning breaks the attack lifecycle because the application rejects any certificate that does not match the expected pin [1].';

  const a = new EvidenceLedger();
  a.addWebSource(page('https://example.test/p', 'P', `${MENU}\n\n${text}`));
  const b = new EvidenceLedger();
  b.restoreWebSource({ n: 1, url: 'https://example.test/p', title: 'P', passages: [...a.sources[0].passages].reverse() });

  assert.equal(a.validate(answer).groundedness, b.validate(answer).groundedness, 'the same evidence scores the same in any order');
});

test('a ledger with no query still renders, so nothing depends on passing one', () => {
  const rendered = buriedAnswerLedger().renderForPrompt();
  assert.ok(String(rendered).length > 0);
  assert.ok(Array.isArray(rendered.dropped_sources));
});
