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

test('the contract locator carries the line alongside the page', () => {
  // This started as a fixture recording the defect: toLocator produces a page
  // OR a heading, never a line, so every chunk of a page collided. The page
  // still comes from the human label - "p. 3" is what reads well under a
  // citation - and the line now travels beside it from the chunk.
  const source = fs.readFileSync(new URL('../src/gateway/contract/events.js', import.meta.url), 'utf8');
  assert.match(source, /if \(page\) return \{ page: Number\(page\[1\]\) \};/, 'toLocator still reads the page from the label');
  assert.match(source, /Number\.isInteger\(s\.line\)/, 'and the mapper adds the line when the chunk has one');
});

/* ------------------------------------------- the fix: a real line, not an ordinal */

const { chunkPages } = await import('../src/agent/services/chunker.js');
const { __testing: contractTesting } = await import('../src/gateway/contract/events.js');

test('a source with no line still produces a valid locator', () => {
  // Web sources have no line, and a document ingested before this change has
  // none either. The contract requires page, heading or line - at least one -
  // so dropping to a page alone must stay valid rather than emit { page, line:
  // null } and fail the schema.
  const mapped = contractTesting.toContractSource({ n: 1, type: 'document', title: 't', snippet: 'x'.repeat(50), doc_id: 'd', locator: 'p. 2', line: null });
  assert.deepEqual(mapped.locator, { page: 2 }, 'a null line is absent, not null');
});

test('a chunk carries the real line it starts on', async () => {
  // Derived from `char_start`, which the chunker already records, by counting
  // the newlines the page actually contains before that offset. A reader can
  // follow "p. 2, line 14" back to the document and find the passage; a chunk
  // ordinal dressed up as a line would satisfy the grader and mislead them.
  const page = {
    page: 2,
    text: Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: ${'retrieval and scoring behaviour, '.repeat(3)}`).join('\n'),
  };
  const chunks = chunkPages([page], { chunkChars: 400, overlap: 40 });
  assert.ok(chunks.length >= 2, 'the page split into several chunks');

  for (const c of chunks) {
    assert.equal(typeof c.line, 'number');
    assert.ok(Number.isInteger(c.line) && c.line >= 1, `line is a positive integer, got ${c.line}`);
    // The claim has to be true: the chunk's text really does begin on that line.
    const lines = page.text.split('\n');
    assert.ok(
      lines[c.line - 1].includes(c.text.split('\n')[0].slice(0, 20)),
      `chunk starting "${c.text.slice(0, 24)}" claims line ${c.line}, which reads "${lines[c.line - 1]?.slice(0, 40)}"`,
    );
  }
});

test('two chunks of one page start on different lines', () => {
  const page = {
    page: 1,
    text: Array.from({ length: 30 }, (_, i) => `Sentence ${i + 1} about ranking, chunking and the behaviour of the retriever.`).join('\n'),
  };
  const chunks = chunkPages([page], { chunkChars: 300, overlap: 30 });
  const lines = chunks.map((c) => c.line);
  assert.equal(new Set(lines).size, lines.length, `lines must be distinct, got ${lines.join(', ')}`);
});

test('the exact collision fixture: same doc, same page, two passages, two keys', async () => {
  // The defect, reproduced as the classifier measured it, and then resolved.
  const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
  const { __testing } = await import('../src/gateway/contract/events.js');

  const page = {
    page: 1,
    text:
      'BM25 scores a document as a sum over query terms of the inverse document frequency of the term.\n'.repeat(4) +
      'Chunks too small retrieve precisely and then hand the model a fragment with no surrounding context.\n'.repeat(4),
  };
  const chunks = chunkPages([page], { chunkChars: 300, overlap: 20 });
  assert.ok(chunks.length >= 2, 'the page produced two chunks');

  const ledger = new EvidenceLedger();
  for (const [i, c] of chunks.entries()) {
    ledger.addDocumentSource({ ...c, chunk_id: `c${i}`, doc_id: 'doc_a', title: 'retrieval-basics.pdf' });
  }

  const contractSources = ledger.publicSources().map((s) => __testing.toContractSource(s));
  const keys = contractSources.map((s) => `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`);

  assert.equal(new Set(keys).size, keys.length, `two chunks of one page must not share a key, got:\n  ${keys.join('\n  ')}`);
  for (const s of contractSources) assert.equal(s.locator.page, 1, 'and the page survives for the reader');
});

test('Map.set no longer evicts the earlier passage, and [1] resolves to its own snippet', async () => {
  // The benchmark-compatible regression: build its haystack, then check that
  // citing the first source finds the first source's text.
  const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
  const { __testing } = await import('../src/gateway/contract/events.js');

  const page = {
    page: 1,
    text:
      'BM25 scores a document as a sum over query terms of the inverse document frequency of the term.\n'.repeat(4) +
      'Chunks too small retrieve precisely and then hand the model a fragment with no surrounding context.\n'.repeat(4),
  };
  const ledger = new EvidenceLedger();
  for (const [i, c] of chunkPages([page], { chunkChars: 300, overlap: 20 }).entries()) {
    ledger.addDocumentSource({ ...c, chunk_id: `c${i}`, doc_id: 'doc_a', title: 'retrieval-basics.pdf' });
  }
  const sources = ledger.publicSources().map((s) => __testing.toContractSource(s));

  const docText = graderHaystack(sources);
  assert.equal(docText.size, sources.slice(0, 5).length + 1, 'every source has its own entry, plus the * fallback');

  const first = sources[0];
  assert.equal(docText.get(locatorKey(first)), first.snippet, 'source 1 was not overwritten');
  assert.equal(snippetIsGrounded(first.snippet, docText.get(locatorKey(first))), true, 'and [1] verifies against its own text');
});

/* ------------------------------ the line has to survive the store, not only the chunker */

/**
 * A chunk that knows its line is worth nothing if the store forgets it.
 *
 * The first attempt at this fix computed the line correctly, carried it through
 * the ledger and the contract mapper, passed every unit test — and moved the
 * measured number by nothing, because three projections in between listed their
 * fields explicitly and `line` was not among them: the record written by
 * `indexChunks`, the row `searchChunks` returns, and the Mongo scan projection.
 * The locator arrived as `{ page }` exactly as before.
 *
 * So this drives the real path: ingest, retrieve, and look at what comes back.
 */

const { createDocument, indexChunks, searchChunks } = await import('../src/agent/services/ragStore.js');

test('a retrieved chunk still carries the line it was chunked at', async () => {
  const doc = await createDocument({ userId: 'usr_line', filename: 'locators.txt', mimetype: 'text/plain', size: 100, spaceId: 'spc_line' });
  const pageText = Array.from(
    { length: 24 },
    (_, i) => `Line ${i + 1}: reciprocal rank fusion combines two ranked lists by summing one over k plus rank.`,
  ).join('\n');
  const chunked = chunkPages([{ page: 1, text: pageText }], { chunkChars: 400, overlap: 40 });
  assert.ok(chunked.length >= 2, 'the page split into several chunks');
  assert.ok(chunked.every((c) => Number.isInteger(c.line)), 'and the chunker gave each one a line');

  await indexChunks(doc, chunked);
  const found = await searchChunks('reciprocal rank fusion summing one over k plus rank', { userId: 'usr_line', spaceId: 'spc_line' });
  assert.ok(found.results.length > 0, 'retrieval returned something to check');

  for (const r of found.results) {
    assert.ok(Number.isInteger(r.line) && r.line >= 1, `a retrieved chunk lost its line: ${JSON.stringify(r).slice(0, 200)}`);
  }
});

test('two retrieved chunks of one page still key apart after a round trip', async () => {
  const doc = await createDocument({ userId: 'usr_key', filename: 'keys.txt', mimetype: 'text/plain', size: 100, spaceId: 'spc_key' });
  const pageText = Array.from(
    { length: 24 },
    (_, i) => `Line ${i + 1}: BM25 saturates term frequency so a word repeated twenty times is not twenty times better.`,
  ).join('\n');
  await indexChunks(doc, chunkPages([{ page: 1, text: pageText }], { chunkChars: 400, overlap: 40 }));

  const found = await searchChunks('BM25 saturates term frequency repeated twenty times', { userId: 'usr_key', spaceId: 'spc_key' });
  const samePage = found.results.filter((r) => r.page === 1);
  assert.ok(samePage.length >= 2, 'at least two chunks of page 1 came back');

  // The end of the chain: what the grader would key on.
  const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
  const ledger = new EvidenceLedger();
  for (const r of samePage) ledger.addDocumentSource(r);
  const keys = ledger.publicSources().map((s) => locatorKey(contractTesting.toContractSource(s)));
  assert.equal(new Set(keys).size, keys.length, `keys must stay distinct through the store, got:\n  ${keys.join('\n  ')}`);
});
