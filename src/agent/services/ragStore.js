import { config } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { embedBatch, embedQuery, cosine, tokenize } from './embeddings.js';
import { usingMongoVectors, vectorBackend, putChunks, nearestChunks, allChunks, deleteChunksForDoc } from './vectorStore.js';

const documents = collection('documents');
const chunks = collection('chunks');

export function createDocument({ userId, filename, mimetype, size }) {
  return documents.put({
    id: newId('doc'),
    user_id: userId,
    filename,
    mimetype,
    size_bytes: size,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    page_count: null,
    chunk_count: 0,
    embedding_provider: null,
    error: null,
    indexed_at: null,
  });
}

export const getDocument = (id) => documents.get(id);

export function listDocuments(userId, opts = {}) {
  return documents.list((d) => d.user_id === userId, { limit: 100, ...opts });
}

export function updateDocument(id, patch) {
  return documents.patch(id, patch);
}

export function deleteDocument(id, userId) {
  const doc = documents.get(id);
  if (!doc || doc.user_id !== userId) return false;
  for (const chunk of [...chunks.items.values()]) {
    if (chunk.doc_id === id) chunks.delete(chunk.id);
  }
  documents.delete(id);
  return true;
}

/** Embed and persist a document's chunks. Reports progress back to the job. */
export async function indexChunks(doc, docChunks, { onProgress } = {}) {
  const batchSize = config.embeddings.batchSize;
  let provider = null;
  for (let i = 0; i < docChunks.length; i += batchSize) {
    const slice = docChunks.slice(i, i + batchSize);
    const { vectors, provider: p } = await embedBatch(slice.map((c) => c.text), { inputType: 'document' });
    provider = p;
    const records = slice.map((chunk, j) => ({
      id: newId('chk'),
      chunk_id: `${doc.id}:${chunk.index}`,
      doc_id: doc.id,
      user_id: doc.user_id,
      filename: doc.filename,
      index: chunk.index,
      page: chunk.page,
      page_label: chunk.page_label,
      text: chunk.text,
      tokens: tokenize(chunk.text),
      embedding: vectors[j],
    }));
    // Written to whichever store is configured. Mongo is the shared one, so it
    // is what a second process would read; the local store stays the default.
    if (usingMongoVectors()) await putChunks(records);
    else for (const r of records) chunks.put(r);
    onProgress?.(Math.min(1, (i + slice.length) / docChunks.length));
  }
  if (!usingMongoVectors()) await chunks.flush();
  return { provider, count: docChunks.length, backend: vectorBackend() };
}

/** Okapi BM25 over the candidate corpus, computed per query. */
/** Descending score order, as a chunk id to 1-based rank map. */
function rank(scores) {
  return new Map(
    [...scores.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => [id, i + 1]),
  );
}

/**
 * Reciprocal rank fusion.
 *
 * Blending normalised scores assumes cosine similarity and BM25 are on
 * comparable scales, which they are not: BM25 is unbounded and corpus
 * dependent, cosine sits in a narrow band, so min-max normalising each makes
 * the blend depend on the spread of whatever happened to be retrieved. One
 * outlier compresses everything else toward zero and the weight stops meaning
 * what it says.
 *
 * RRF uses each ranker's *ordering* instead of its numbers, so no scale has to
 * be reconciled. A chunk ranked highly by either retriever scores well; one
 * ranked highly by both scores best. k damps the top of the curve so rank 1 is
 * not overwhelmingly larger than rank 2.
 */
function reciprocalRankFusion(rankings, { k = 60 } = {}) {
  const out = new Map();
  for (const { ranking, weight } of rankings) {
    for (const [id, r] of ranking) {
      out.set(id, (out.get(id) || 0) + weight * (1 / (k + r)));
    }
  }
  return out;
}

function bm25Scores(queryTerms, corpus, { k1 = 1.5, b = 0.75 } = {}) {
  const N = corpus.length;
  if (!N) return new Map();
  const df = new Map();
  let totalLen = 0;
  for (const doc of corpus) {
    totalLen += doc.tokens.length;
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgdl = totalLen / N || 1;
  const scores = new Map();
  for (const doc of corpus) {
    const tf = new Map();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.tokens.length / avgdl))));
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

function normalizeScores(map) {
  const values = [...map.values()];
  if (!values.length) return map;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const out = new Map();
  // A tied set (including a single candidate) must not normalise to zero,
  // that would silently discard the only matches in a small corpus.
  if (span === 0) {
    for (const [k, v] of map) out.set(k, v > 0 ? 1 : 0);
    return out;
  }
  for (const [k, v] of map) out.set(k, (v - min) / span);
  return out;
}

/**
 * Hybrid retrieval: dense cosine blended with BM25. The blend matters most
 * when the local (lexical) embedder is active. It keeps recall usable with no
 * embedding key configured.
 */
export async function searchChunks(query, { userId, docIds, topK = config.rag.topK, recorder } = {}) {
  const { vector, provider } = await embedQuery(query, { recorder });

  // Dense retrieval happens where the chunks live: the index does it on Atlas,
  // a scan does it on a local mongod, and the in-process store does it here.
  // Everything after this point is identical, because fusion works on rankings
  // rather than on whatever each backend calls a score.
  let corpus;
  let dense = new Map();
  let backend;

  if (usingMongoVectors()) {
    const [near, all] = await Promise.all([
      nearestChunks(vector, { userId, docIds, limit: Math.max(topK * 8, 50) }),
      allChunks({ userId, docIds }),
    ]);
    backend = near.backend;
    corpus = all;
    for (const c of near.candidates) dense.set(c.id ?? c.chunk_id, c.score);
  } else {
    backend = 'in-process';
    corpus = [...chunks.items.values()].filter(
      (c) => c.user_id === userId && (!docIds?.length || docIds.includes(c.doc_id)),
    );
    for (const chunk of corpus) dense.set(chunk.id, cosine(vector, chunk.embedding));
  }

  if (!corpus.length) return { results: [], corpus_size: 0, embedding_provider: provider, backend };

  const lexical = bm25Scores(tokenize(query), corpus);
  // The local embedder is lexical, not semantic, so leaning on it as if it
  // were dense retrieval double-counts the same signal. Shift weight to BM25.
  const w = provider === 'local' ? Math.min(config.rag.denseWeight, 0.4) : config.rag.denseWeight;

  const fused = reciprocalRankFusion([
    { ranking: rank(dense), weight: w },
    { ranking: rank(lexical), weight: 1 - w },
  ]);

  const scored = corpus
    .map((chunk) => ({
      chunk,
      score: fused.get(chunk.id) || 0,
      dense_score: Number((dense.get(chunk.id) || 0).toFixed(4)),
      lexical_score: Number((lexical.get(chunk.id) || 0).toFixed(4)),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    corpus_size: corpus.length,
    embedding_provider: provider,
    backend,
    results: scored.map((r) => ({
      chunk_id: r.chunk.id,
      doc_id: r.chunk.doc_id,
      filename: r.chunk.filename,
      page: r.chunk.page,
      page_label: r.chunk.page_label,
      text: r.chunk.text,
      score: Number(r.score.toFixed(4)),
      dense_score: r.dense_score,
      lexical_score: r.lexical_score,
    })),
  };
}

export function documentStats(userId) {
  const docs = [...documents.items.values()].filter((d) => d.user_id === userId);
  return {
    documents: docs.length,
    indexed: docs.filter((d) => d.status === 'indexed').length,
    chunks: [...chunks.items.values()].filter((c) => c.user_id === userId).length,
  };
}
