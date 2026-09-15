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

export function vectorBackend() {
  if (!mongoEnabled()) return 'in-process';
  return config.mongo.vectorBackend;
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
    .project({ id: 1, text: 1, chunk_id: 1, doc_id: 1, filename: 1, page: 1, page_label: 1, user_id: 1, embedding: 1 })
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
