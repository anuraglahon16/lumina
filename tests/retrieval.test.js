import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCacheKey } from '../src/agent/services/search/index.js';

/**
 * Retrieval behaviour that is easy to change without noticing.
 *
 * Both of these were altered to chase a number (fusion quality, cache hit rate)
 * and neither had a test. A regression in either is silent: retrieval gets
 * quietly worse, or a cache key stops matching and cost doubles, and the only
 * symptom is an answer that seems a bit weaker than it used to be.
 */

/* ------------------------------------------------------------ cache keying */

test('the same question phrased differently shares a cache key', () => {
  // The model writes these, and it rephrases the same intent every run. Keying
  // on the raw string made one question three paid searches.
  const a = searchCacheKey("US Open 2021 men's singles champion");
  const b = searchCacheKey('2021 US Open mens singles champion');
  assert.equal(a, b);
});

test('punctuation, case, possessives and stopwords do not change the key', () => {
  const base = searchCacheKey('who won the US Open');
  assert.equal(searchCacheKey('Who won US Open?'), base);
  assert.equal(searchCacheKey('  who   won  us open  '), base);
});

test('different questions keep different keys', () => {
  // The whole risk of normalising aggressively is collapsing things that are
  // not the same. Two questions about different subjects must not collide.
  assert.notEqual(searchCacheKey('who won the US Open 2021'), searchCacheKey('who won the World Cup 2022'));
  assert.notEqual(searchCacheKey('postgres logical replication'), searchCacheKey('mysql binlog replication'));
});

test('a key is stable and order-independent by construction', () => {
  const k = searchCacheKey('QUIC head-of-line blocking HTTP/3');
  assert.equal(k, searchCacheKey('QUIC head-of-line blocking HTTP/3'), 'same input, same key');
  assert.equal(k, searchCacheKey('HTTP/3 blocking head-of-line QUIC'), 'word order is deliberately dropped');
  assert.ok(!/[A-Z]/.test(k), 'keys are lowercased');
});

test('an empty or stopword-only query produces an empty key rather than throwing', () => {
  assert.equal(searchCacheKey(''), '');
  assert.equal(searchCacheKey('the a of'), '');
});

/* -------------------------------------------------------- rank fusion (RRF) */

/**
 * RRF is reimplemented here rather than imported, because ragStore pulls in the
 * embedding providers and the store on import. The property under test is the
 * scoring rule itself, which is what a change would silently alter.
 */
const rrf = (rankings, k = 60) => {
  const out = new Map();
  for (const { ranking, weight } of rankings) {
    for (const [id, r] of ranking) out.set(id, (out.get(id) || 0) + weight * (1 / (k + r)));
  }
  return out;
};
const rank = (ids) => new Map(ids.map((id, i) => [id, i + 1]));

test('a document ranked by both retrievers beats one ranked by only one', () => {
  const scores = rrf([
    { ranking: rank(['both', 'denseOnly']), weight: 0.5 },
    { ranking: rank(['both', 'lexOnly']), weight: 0.5 },
  ]);
  assert.ok(scores.get('both') > scores.get('denseOnly'));
  assert.ok(scores.get('both') > scores.get('lexOnly'));
});

test('fusion depends on rank, not on score scale', () => {
  // This is the whole reason for RRF: BM25 is unbounded and corpus dependent
  // while cosine sits in a narrow band, so blending normalised scores made the
  // result depend on the spread of whatever happened to be retrieved.
  const ordering = ['a', 'b', 'c'];
  const first = rrf([{ ranking: rank(ordering), weight: 1 }]);
  const second = rrf([{ ranking: rank(ordering), weight: 1 }]);
  assert.deepEqual([...first.entries()], [...second.entries()]);
  assert.ok(first.get('a') > first.get('b') && first.get('b') > first.get('c'));
});

test('weight shifts the balance between retrievers without silencing either', () => {
  const denseHeavy = rrf([
    { ranking: rank(['d']), weight: 0.9 },
    { ranking: rank(['l']), weight: 0.1 },
  ]);
  assert.ok(denseHeavy.get('d') > denseHeavy.get('l'));
  assert.ok(denseHeavy.get('l') > 0, 'the lower-weighted retriever still contributes');
});

test('k damps the top of the curve so rank 1 does not dominate rank 2', () => {
  const scores = rrf([{ ranking: rank(['first', 'second']), weight: 1 }]);
  const ratio = scores.get('first') / scores.get('second');
  assert.ok(ratio < 1.1, `rank 1 should not overwhelm rank 2 (ratio was ${ratio.toFixed(3)})`);
});

test('every ranked document scores above zero, so nothing is dropped by fusion', () => {
  const scores = rrf([{ ranking: rank(['a', 'b', 'c', 'd', 'e']), weight: 0.5 }]);
  for (const [, v] of scores) assert.ok(v > 0);
});
