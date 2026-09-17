import { config } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { embedBatch, embedQuery, cosine, tokenize } from './embeddings.js';
import { usingMongoVectors, vectorBackend, putChunks, nearestChunks, allChunks, deleteChunksForDoc, countChunks } from './vectorStore.js';
import { compact } from '../store/filter.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('rag');

const documents = collection('documents');
const chunks = collection('chunks');

export async function createDocument({ userId, filename, mimetype, size, spaceId = null }) {
  return documents.put({
    id: newId('doc'),
    user_id: userId,
    space_id: spaceId,
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

export async function listDocuments(userId, opts = {}) {
  return documents.list({ user_id: userId }, { limit: 100, ...opts });
}

export async function updateDocument(id, patch) {
  return documents.patch(id, patch);
}

export async function deleteDocument(id, userId) {
  const doc = await documents.get(id);
  if (!doc || doc.user_id !== userId) return false;
  if (usingMongoVectors()) {
    await deleteChunksForDoc(id);
  } else {
    for (const chunk of await chunks.all({ doc_id: id })) await chunks.delete(chunk.id);
  }
  await documents.delete(id);
  return true;
}

/**
 * Embed and persist a document's chunks, all in one vector space.
 *
 * The embedding happens before anything is written, and every chunk is checked
 * to have come from the same namespace before any of it is persisted. That
 * ordering is the whole point. Embedding slice by slice and writing as it went
 * meant a document whose provider was rate limited halfway through ended up
 * part remote vectors and part local ones — and cosine similarity across two
 * models is not a worse similarity, it is a meaningless number that the
 * arithmetic happily returns. Nothing errored. The document looked indexed,
 * search returned results, and recall was zero.
 *
 * If the namespaces disagree the whole document is embedded again with the
 * fallback, because a document half in one space is worse than a document
 * wholly in the weaker one.
 */
export async function indexChunks(doc, docChunks, { onProgress } = {}) {
  const texts = docChunks.map((c) => c.text);
  const batchSize = config.embeddings.batchSize;

  const embedAll = async (forced) => {
    const out = [];
    const namespaces = new Set();
    let meta = null;
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      const res = await embedBatch(slice, { inputType: 'document', ...(forced ? { provider: forced } : {}) });
      out.push(...res.vectors);
      if (res.namespace) namespaces.add(res.namespace);
      meta = res;
      // Progress covers embedding only; persistence is fast by comparison.
      onProgress?.(Math.min(0.95, (i + slice.length) / texts.length));
    }
    return { vectors: out, namespaces, meta };
  };

  let { vectors, namespaces, meta } = await embedAll(null);

  if (namespaces.size > 1) {
    // One provider failed partway. Redo the document in the space every chunk
    // can reach rather than persisting a mixture.
    log.warn('embedding_namespace_split_reindexing', { doc_id: doc.id, namespaces: [...namespaces] });
    ({ vectors, namespaces, meta } = await embedAll('local'));
  }

  const namespace = [...namespaces][0] ?? null;
  const records = docChunks.map((chunk, j) => ({
    id: newId('chk'),
    chunk_id: `${doc.id}:${chunk.index}`,
    doc_id: doc.id,
    user_id: doc.user_id,
    space_id: doc.space_id ?? null,
    filename: doc.filename,
    index: chunk.index,
    page: chunk.page,
    page_label: chunk.page_label,
    text: chunk.text,
    tokens: tokenize(chunk.text),
    embedding: vectors[j],
    // Carried on the chunk, not only on the document, because retrieval
    // compares chunks and has to know which of them may be compared.
    embedding_namespace: namespace,
    embedding_provider: meta?.provider ?? null,
    embedding_model: meta?.model ?? null,
    embedding_dimension: meta?.dim ?? null,
  }));

  if (usingMongoVectors()) await putChunks(records);
  else for (const r of records) await chunks.put(r);
  if (!usingMongoVectors()) await chunks.flush();
  onProgress?.(1);

  return {
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    dim: meta?.dim ?? null,
    namespace,
    count: docChunks.length,
    backend: vectorBackend(),
  };
}

/** A chunk written before namespaces existed: describe it from what it has. */
function legacyNamespace(chunk) {
  const dim = Array.isArray(chunk.embedding) ? chunk.embedding.length : 0;
  return `legacy:unknown:${dim}:v0`;
}

/** The provider half of a namespace string. */
function providerFromNamespace(ns) {
  const provider = String(ns || '').split(':')[0];
  return provider && provider !== 'legacy' ? provider : undefined;
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
/**
 * Which embedder produced the vectors we are about to search.
 *
 * Taken from the documents themselves rather than from configuration, because
 * configuration says what the next document will use, not what the last one
 * did.
 */
async function corpusProvider(userId, docIds) {
  const { items } = await documents.list({ user_id: userId }, { limit: 50 });
  const relevant = items.filter((d) => d.embedding_provider && (!docIds?.length || docIds.includes(d.id)));
  if (!relevant.length) return undefined;
  const counts = new Map();
  for (const d of relevant) counts.set(d.embedding_provider, (counts.get(d.embedding_provider) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export async function searchChunks(query, { userId, docIds, spaceId, topK = config.rag.topK, recorder } = {}) {
  // A Space is the scope the question was asked in. Searching outside it would
  // answer from documents the asker did not point at.
  if (spaceId && !docIds?.length) {
    const { items } = await documents.list({ user_id: userId, space_id: spaceId }, { limit: 500 });
    docIds = items.map((d) => d.id);
    if (!docIds.length) return { results: [], corpus_size: 0, embedding_provider: null, backend: 'none' };
  }
  // Dense retrieval happens where the chunks live: the index does it on Atlas,
  // a scan does it on a local mongod, and the in-process store does it here.
  // Everything after this point is identical, because fusion works on rankings
  // rather than on whatever each backend calls a score.
  let corpus;
  let backend;

  if (usingMongoVectors()) {
    corpus = await allChunks({ userId, docIds });
    backend = vectorBackend();
  } else {
    backend = 'in-process';
    corpus = await chunks.all(compact({ user_id: userId, doc_id: docIds?.length ? { $in: docIds } : undefined }));
  }

  if (!corpus.length) return { results: [], corpus_size: 0, embedding_provider: null, backend };

  /**
   * Group the corpus by the space its vectors live in, and score each group
   * against a query embedded the same way.
   *
   * A Space can legitimately hold more than one: a document indexed while the
   * remote provider was rate limited is local, one indexed an hour later is
   * not, and both are perfectly good — they simply cannot be compared to each
   * other, or to one query vector. Scoring them together produces numbers the
   * arithmetic is happy to return and that mean nothing.
   *
   * So each namespace is ranked on its own and the rankings are fused. Rank
   * fusion is what makes this sound: a position within a group survives being
   * merged across groups, where a raw cosine from one model would not.
   */
  const byNamespace = new Map();
  for (const chunk of corpus) {
    const ns = chunk.embedding_namespace || legacyNamespace(chunk);
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns).push(chunk);
  }

  const dense = new Map();
  let provider = null;
  for (const [ns, group] of byNamespace) {
    const wanted = group[0]?.embedding_provider || providerFromNamespace(ns);
    let queryVector;
    try {
      const embedded = await embedQuery(query, { recorder, provider: wanted });
      // If the query could not be embedded in this group's space — the provider
      // is down, the key is gone — this group gets no dense scores at all
      // rather than scores against the wrong model. BM25 still reaches it.
      if (embedded.provider !== wanted) continue;
      queryVector = embedded.vector;
      provider = provider ?? embedded.provider;
    } catch {
      continue;
    }

    const ranked = new Map();
    for (const chunk of group) {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== queryVector.length) continue;
      ranked.set(chunk.id, cosine(queryVector, chunk.embedding));
    }
    // Ranked within the namespace, then merged: a position is comparable
    // across groups in a way a similarity score is not.
    for (const [id, r] of rank(ranked)) dense.set(id, 1 / (60 + r));
  }

  // Lexical retrieval spans every namespace, because it needs no vectors at
  // all. It is the floor under the whole scheme: a corpus whose embedder is
  // unreachable is still searchable, just less well.
  const lexical = bm25Scores(tokenize(query), corpus);
  // The local embedder is lexical, not semantic, so leaning on it as if it
  // were dense retrieval double-counts the same signal. Shift weight to BM25.
  const w = provider === 'local' || !dense.size ? Math.min(config.rag.denseWeight, 0.4) : config.rag.denseWeight;

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

export async function documentStats(userId, { spaceId = null } = {}) {
  // Scoped when a Space was named, because "this user has documents" and "the
  // Space this question was asked in has documents" are different facts, and it
  // is the second one that decides whether offering a document search is
  // honest. Offering it over an empty scope produces a tool that can only fail.
  const all = await documents.all({ user_id: userId });
  const docs = spaceId ? all.filter((d) => d.space_id === spaceId) : all;
  return {
    documents: docs.length,
    indexed: docs.filter((d) => d.status === 'indexed').length,
    chunks: usingMongoVectors() ? await countChunks(userId) : await chunks.count({ user_id: userId }),
  };
}
