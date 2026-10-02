import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { mongoDb, mongoEnabled } from '../store/mongo.js';

const log = createLogger('vectorstore');

/**
 * Chunk storage and vector retrieval in MongoDB.
 *
 * Two backends, because `$vectorSearch` is an Atlas feature and a local mongod
 * does not have it. Rather than pretend otherwise, the fallback scans and says
 * so in health: a developer running mongod locally gets working retrieval with
 * honest labelling, and the same code path on Atlas uses the real index.
 *
 * Only reached when MONGODB_URI is set. Without it the JSON-backed store is
 * used exactly as before.
 */

export const usingMongoVectors = () => mongoEnabled();

/**
 * What the deployment is *configured* to use. Not what served a query.
 *
 * Kept for the one thing it is good for - deciding which branch to take - and
 * deliberately not reported as fact. See `retrievalBackend()`.
 */
export function configuredVectorBackend() {
  if (!mongoEnabled()) return 'in-process';
  return config.mongo.vectorBackend;
}

/**
 * The backend that actually served the last retrieval.
 *
 * `/health`, `/stats` and the eval report used to print the configured value,
 * so they claimed `atlas-vector-search` while no `$vectorSearch` had ever run:
 * `nearestChunks` has no callers and retrieval is a cosine scan in JavaScript
 * blended with BM25. A recall number is not comparable without knowing which
 * one produced it, which is exactly why the contract says "name whatever is
 * live".
 *
 * Before any query has run there is nothing observed, so the honest answer is
 * what the code would do, marked as not yet exercised.
 */
let observed = null;
let probeStatus = 'not_probed';
/** Set only where a real `$vectorSearch` returned for a real query. */
let servedByVectorSearch = false;

export function noteVectorSearchServed() {
  servedByVectorSearch = true;
  observed = 'atlas-vector-search';
}

export function noteRetrievalBackend(name) {
  if (!name || name === 'none') return;
  /**
   * The one label that cannot be taken on trust.
   *
   * `atlas-vector-search` is only true if an aggregation actually served a
   * query, so it may be set only through `noteVectorSearchServed`, from inside
   * that code path. Anything else claiming it is ignored and logged - the whole
   * history of this field is of it being asserted from configuration rather than
   * observed.
   */
  if (name === 'atlas-vector-search' && !servedByVectorSearch) {
    log.warn('backend_claim_rejected', { claimed: name, reason: 'no $vectorSearch has served a query' });
    return;
  }
  observed = name;
}

/**
 * Ask each vector index, once, at boot, whether it can actually be queried.
 *
 * Without this `/health` has nothing to report until the first search, and the
 * benchmark reads `/health` before it asks anything - so the header of every run
 * recorded a claim that had never been tested. Worse, the claim was the
 * configured value, which was wrong for months: the index the code names did not
 * exist, its dimensions did not match the embedder, and its filter paths were
 * camelCase against snake_case documents. A query returning nothing looks exactly
 * like a corpus that is empty.
 *
 * One minimal `$vectorSearch` per index, with a filter that deliberately matches
 * nothing. Success means the index exists, accepts this vector width, and accepts
 * these filter paths - which is everything that was wrong. Failure is recorded
 * and reported; it never stops the agent from starting, because retrieval still
 * works by scanning and a refusal to boot would turn a degraded search into an
 * outage.
 */
export async function probeVectorIndexes({ client } = {}) {
  // `client` is a seam for tests only, and deliberately not reachable from a
  // request: the success path cannot otherwise be exercised without an Atlas
  // cluster, and the success path is the one that used to lie.
  if (!client && !mongoEnabled()) {
    probeStatus = 'skipped: no MONGODB_URI';
    return probeStatus;
  }
  const dim = config.mongo.vectorDim;
  // Not a zero vector: Atlas refuses cosine similarity against one, which makes
  // a healthy index look broken. A unit vector along one axis is valid and
  // matches nothing meaningful.
  const probeVector = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));
  const targets = [
    { collection: 'chunks', index: config.mongo.vectorIndex, filter: { userId: '__probe__' } },
    { collection: 'memories', index: config.mongo.memoryVectorIndex, filter: { userId: '__probe__' } },
  ];

  const failures = [];
  for (const t of targets) {
    try {
      const col = (client ?? (await mongoDb())).collection(t.collection);
      await col
        .aggregate([
          { $vectorSearch: { index: t.index, path: 'embedding', queryVector: probeVector, numCandidates: 10, limit: 1, filter: t.filter } },
          { $limit: 1 },
        ])
        .toArray();
    } catch (err) {
      failures.push(`${t.collection}/${t.index}: ${String(err.message).split('\n')[0].slice(0, 120)}`);
    }
  }

  if (failures.length) {
    probeStatus = `probe_failed: ${failures.join(' | ')}`;
    log.warn('vector_probe_failed', { detail: probeStatus });
  } else {
    probeStatus = 'ok: both indexes answered at boot';
    log.info('vector_probe_ok', { indexes: targets.map((t) => t.index) });
  }
  /**
   * Deliberately does not touch `observed`.
   *
   * An index that answers a probe is usable; it is not evidence that retrieval
   * used it. Setting the backend here was the same overclaim this module exists
   * to prevent, one level up: `nearestChunks` still has no callers, so a probe
   * success alongside `retrievalBackend() === 'atlas-vector-search'` would have
   * said the index was serving queries when nothing had asked it one.
   */
  return probeStatus;
}

/**
 * The indexes and what the boot probe found, which is a different question from
 * what served a query. Named so the two cannot be confused in a report.
 */
export function vectorIndexStatus() {
  return `${config.mongo.vectorIndex}+${config.mongo.memoryVectorIndex}: ${probeStatus}`;
}

/** Kept as an alias so existing readers do not silently change meaning. */
export function vectorBackendStatus() {
  return vectorIndexStatus();
}

/**
 * What actually served the last real query. Never derived from configuration,
 * and never from the boot probe.
 */
export function retrievalBackend() {
  return observed ?? 'unexercised: no query served yet';
}

/** @deprecated name kept so nothing silently changes meaning; prefer the two above. */
export function vectorBackend() {
  return retrievalBackend();
}

export async function putChunks(records) {
  if (!records.length) return 0;
  const col = (await mongoDb()).collection('chunks');
  // Re-indexing a document replaces its chunks rather than accumulating them.
  const ops = records.map((r) => ({
    replaceOne: { filter: { chunk_id: r.chunk_id }, replacement: r, upsert: true },
  }));
  const res = await col.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0);
}

export async function deleteChunksForDoc(docId) {
  const col = (await mongoDb()).collection('chunks');
  const res = await col.deleteMany({ doc_id: docId });
  return res.deletedCount || 0;
}

export async function countChunks(userId) {
  const col = (await mongoDb()).collection('chunks');
  return col.countDocuments(userId ? { user_id: userId } : {});
}

/**
 * Nearest chunks by embedding.
 *
 * Returns `{ backend, candidates }` where each candidate carries its similarity
 * so the caller can fuse it with a lexical ranking. The Atlas path lets the
 * index do the work; the scan path pulls the user's chunks and computes cosine
 * here, which is fine at development scale and honest about not being more.
 */
export async function nearestChunks(vector, { userId, docIds, limit = 50 } = {}) {
  const col = (await mongoDb()).collection('chunks');
  const filter = { user_id: userId };
  if (docIds?.length) filter.doc_id = { $in: docIds };

  if (config.mongo.vectorBackend === 'atlas-vector-search') {
    try {
      const candidates = await col
        .aggregate([
          {
            $vectorSearch: {
              index: config.mongo.vectorIndex,
              path: 'embedding',
              queryVector: vector,
              numCandidates: Math.max(limit * 10, 100),
              limit,
              filter,
            },
          },
          { $addFields: { score: { $meta: 'vectorSearchScore' } } },
          { $project: { embedding: 0 } },
        ])
        .toArray();
      // The only place this backend may be claimed from.
      noteVectorSearchServed();
      return { backend: 'atlas-vector-search', candidates };
    } catch (err) {
      // An index that is still building, or a cluster that is not Atlas after
      // all. Degrade to the scan rather than returning nothing: a slower
      // answer beats a wrong claim that the corpus is empty.
      log.warn('vector_search_failed_scanning', { err: String(err.message).slice(0, 160) });
    }
  }

  // `id` must be projected: fusion keys candidates by it, and omitting it
  // silently dropped every dense score, leaving BM25 to rank alone.
  const rows = await col
    .find(filter)
    .project({ id: 1, text: 1, chunk_id: 1, doc_id: 1, filename: 1, page: 1, page_label: 1, line: 1, user_id: 1, embedding: 1 })
    .toArray();
  const scored = rows
    .map((r) => ({ ...r, score: cosine(vector, r.embedding), embedding: undefined }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { backend: 'mongo-cosine-scan', candidates: scored };
}

/** All of a user's chunks, for the lexical half of hybrid retrieval. */
export async function allChunks({ userId, docIds } = {}) {
  const col = (await mongoDb()).collection('chunks');
  const filter = { user_id: userId };
  if (docIds?.length) filter.doc_id = { $in: docIds };
  return col.find(filter).project({ embedding: 0 }).toArray();
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
