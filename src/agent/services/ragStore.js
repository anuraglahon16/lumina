import { config } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { embedBatch, embedQuery, cosine, tokenize } from './embeddings.js';

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
    slice.forEach((chunk, j) => {
      chunks.put({
        id: newId('chk'),
        doc_id: doc.id,
        user_id: doc.user_id,
        filename: doc.filename,
        index: chunk.index,
        page: chunk.page,
        page_label: chunk.page_label,
        text: chunk.text,
        tokens: tokenize(chunk.text),
        embedding: vectors[j],
      });
    });
    onProgress?.(Math.min(1, (i + slice.length) / docChunks.length));
  }
  await chunks.flush();
  return { provider, count: docChunks.length };
}

/** Okapi BM25 over the candidate corpus, computed per query. */
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
  const corpus = [...chunks.items.values()].filter(
    (c) => c.user_id === userId && (!docIds?.length || docIds.includes(c.doc_id)),
  );
  if (!corpus.length) return { results: [], corpus_size: 0, embedding_provider: null };

  const { vector, provider } = await embedQuery(query, { recorder });
  const dense = new Map();
  for (const chunk of corpus) dense.set(chunk.id, cosine(vector, chunk.embedding));

  const lexical = bm25Scores(tokenize(query), corpus);
  const nDense = normalizeScores(dense);
  const nLex = normalizeScores(lexical);
  // The local embedder is lexical, not semantic, so leaning on it as if it
  // were dense retrieval double-counts the same signal. Shift weight to BM25.
  const w = provider === 'local' ? Math.min(config.rag.denseWeight, 0.4) : config.rag.denseWeight;

  const scored = corpus
    .map((chunk) => ({
      chunk,
      score: w * (nDense.get(chunk.id) || 0) + (1 - w) * (nLex.get(chunk.id) || 0),
      dense_score: Number((dense.get(chunk.id) || 0).toFixed(4)),
      lexical_score: Number((lexical.get(chunk.id) || 0).toFixed(4)),
    }))
    .filter((r) => r.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    corpus_size: corpus.length,
    embedding_provider: provider,
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
