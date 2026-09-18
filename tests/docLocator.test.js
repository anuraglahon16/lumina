import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snippetIsGrounded } from '../benchmark/lib.mjs';

/**
 * Two chunks of one page are one key, and the grader keeps only the last.
 *
 * `bench.mjs` scores a document citation against a haystack it builds per
 * source: `docText.set(locatorKey(s), s.snippet)` for the first five doc
 * sources, where
 *
 *   locatorKey = `${docId}:${locator.page}:${locator.heading}:${locator.line}`
 *
 * and its own comment says why: "Full locator identity: two chunks of one
 * document must not share a key."
 *
 * Ours share one. A document source carries `{ page }` and nothing else, so
 * every chunk from page 1 of a document collides. `Map.set` keeps the last, and
 * a citation to the first is then compared against a different chunk's text and
 * fails — an honest citation, a correct page, a real snippet, scored against
 * the wrong passage.
 *
 * Measured on a real docs run: six sources, five distinct keys, sources 1 and 5
 * both `doc_mu6kwshke10qel:1::`. Four of twelve document citations failed and
 * every one of them failed this way. The "beyond the first five" theory did not
 * fire once.
 *
 * Nothing is fixed here. This pins the mechanism so the fix has something to
 * satisfy, and so a later change that appears to help can be checked against
 * the actual cause.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-doclocator-'));
process.env.MONGODB_URI = '';

/** Verbatim from bench.mjs. */
const locatorKey = (s) => `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`;

/** The haystack bench.mjs builds for a document answer. */
function graderHaystack(sources) {
  const top5 = sources.filter((s) => s.kind === 'doc').slice(0, 5);
  const docText = new Map([['*', top5.map((s) => s.snippet).join('\n')]]);
  for (const s of top5) docText.set(locatorKey(s), s.snippet);
  return docText;
}

const chunk = (n, page, snippet, docId = 'doc_a') => ({ n, kind: 'doc', docId, locator: { page }, snippet });

test('a locator carrying only a page cannot identify a chunk', () => {
  const a = chunk(1, 1, 'BM25 scores a document as a sum over query terms of the inverse document frequency.');
  const b = chunk(5, 1, 'Chunks too small retrieve precisely and hand the model a fragment with no context.');
  assert.equal(locatorKey(a), locatorKey(b), 'two chunks of page 1 are indistinguishable to the grader');
});

test('the second chunk of a page evicts the first from the grader map', () => {
  const sources = [
    chunk(1, 1, 'BM25 scores a document as a sum over query terms of the inverse document frequency of the term.'),
    chunk(2, 2, 'The b parameter controls how much document length normalisation is applied to the score.'),
    chunk(5, 1, 'Chunks too small retrieve precisely and then hand the model a fragment with no surrounding context.'),
  ];
  const docText = graderHaystack(sources);

  assert.equal(docText.get(locatorKey(sources[0])), sources[2].snippet, 'source 5 overwrote source 1');
  assert.notEqual(docText.get(locatorKey(sources[0])), sources[0].snippet);
});

test('citing the evicted chunk fails even though the citation is honest', () => {
  // The whole defect, end to end: a real chunk, a real page, a real snippet,
  // scored against a different passage and reported as unverifiable provenance.
  const cited = chunk(1, 1, 'BM25 scores a document as a sum over query terms of the inverse document frequency of the term.');
  const sibling = chunk(5, 1, 'Chunks too small retrieve precisely and then hand the model a fragment with no surrounding context.');
  const docText = graderHaystack([cited, chunk(2, 2, 'unrelated page two text about normalisation and length'), sibling]);

  const hay = docText.get(locatorKey(cited)) ?? docText.get('*');
  assert.equal(snippetIsGrounded(cited.snippet, hay), false, 'the honest citation is scored as ungrounded');

  // And it would have passed against its own text, which is what makes this a
  // key collision rather than a bad snippet.
  assert.equal(snippetIsGrounded(cited.snippet, cited.snippet), true);
});

test('a unique locator makes the same citation verifiable', () => {
  // What the fix has to achieve, stated as a property rather than as an
  // implementation: distinct chunks need distinct keys. A line, a heading, an
  // ordinal - the grader reads all three - anything that separates them.
  const cited = { ...chunk(1, 1, 'BM25 scores a document as a sum over query terms of the inverse document frequency of the term.'), locator: { page: 1, line: 1 } };
  const sibling = { ...chunk(5, 1, 'Chunks too small retrieve precisely and then hand the model a fragment with no surrounding context.'), locator: { page: 1, line: 2 } };

  const docText = graderHaystack([cited, sibling]);
  assert.notEqual(locatorKey(cited), locatorKey(sibling), 'distinct chunks, distinct keys');
  assert.equal(snippetIsGrounded(cited.snippet, docText.get(locatorKey(cited))), true, 'and the citation verifies');
  assert.equal(snippetIsGrounded(sibling.snippet, docText.get(locatorKey(sibling))), true);
});

test('a sixth document source is invisible to the grader', () => {
  // The other structural possibility, pinned because it is real even though the
  // measured failures were not this. RAG_TOP_K is 6 and the grader keys only
  // the first five, so a citation to the sixth finds neither its own entry nor
  // its text in the '*' fallback.
  const sources = Array.from({ length: 6 }, (_, i) =>
    chunk(i + 1, i + 1, `Passage number ${i + 1} about retrieval, chunking, scoring and the behaviour of the ranker.`),
  );
  const docText = graderHaystack(sources);
  const sixth = sources[5];

  assert.equal(docText.get(locatorKey(sixth)), undefined, 'the sixth has no keyed entry');
  assert.equal(snippetIsGrounded(sixth.snippet, docText.get('*')), false, 'and is not in the fallback either');
});

test('our document sources really do carry only a page', () => {
  // Stated as a fixture so the cause cannot quietly change underneath the
  // classification. If a heading or line appears here later, the collision may
  // be gone and the distribution has to be measured again.
  const source = fs.readFileSync(new URL('../src/gateway/contract/events.js', import.meta.url), 'utf8');
  assert.match(source, /toLocator/, 'the contract maps our label to a locator');
  // toLocator produces { page } from "p. 3" and { heading } from anything else;
  // a chunk with a page therefore never also carries a heading or a line.
  assert.match(source, /if \(page\) return \{ page: Number\(page\[1\]\) \};/);
});
