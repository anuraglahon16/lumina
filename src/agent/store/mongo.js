import { MongoClient } from 'mongodb';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('mongo');

/**
 * MongoDB connection and index management.
 *
 * Optional by design: with MONGODB_URI unset the agent keeps using the JSON
 * store and nothing here runs. That keeps a working single-container
 * deployment working, and makes the database something you turn on when you
 * need what it actually buys, which is state shared between processes.
 *
 * One client per process. The driver pools connections internally, so opening
 * one per request would be slower, not more isolated.
 */

let client = null;
let connecting = null;

export const mongoEnabled = () => Boolean(config.mongo.uri);

export async function mongoDb() {
  if (!config.mongo.uri) throw new Error('MONGODB_URI is not set');
  if (client) return client.db(config.mongo.db);
  if (!connecting) {
    connecting = (async () => {
      const c = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000 });
      await c.connect();
      client = c;
      log.info('mongo_connected', { db: config.mongo.db, vector_backend: config.mongo.vectorBackend });
      return c;
    })().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  await connecting;
  return client.db(config.mongo.db);
}

export async function pingMongo() {
  if (!mongoEnabled()) return 'disabled';
  try {
    await (await mongoDb()).command({ ping: 1 });
    return 'ok';
  } catch (err) {
    log.warn('mongo_ping_failed', { err: err.message });
    return 'down';
  }
}

/**
 * Indexes the chunk collection needs.
 *
 * The vector index is Atlas-only and is created through a different API than
 * ordinary indexes, so it is attempted separately and its absence is not an
 * error: a local mongod simply cannot have one, which is exactly the case the
 * cosine-scan backend exists for.
 */
export async function ensureChunkIndexes() {
  const db = await mongoDb();
  const chunks = db.collection('chunks');
  await chunks.createIndex({ user_id: 1, doc_id: 1 });
  await chunks.createIndex({ chunk_id: 1 }, { unique: true });
  // Lexical half of hybrid retrieval when Atlas Search is unavailable.
  await chunks.createIndex({ text: 'text' });

  if (config.mongo.vectorBackend !== 'atlas-vector-search') return { vector: 'skipped' };
  try {
    await db.command({
      createSearchIndexes: 'chunks',
      indexes: [
        {
          name: config.mongo.vectorIndex,
          type: 'vectorSearch',
          definition: {
            fields: [
              { type: 'vector', path: 'embedding', numDimensions: config.mongo.vectorDim, similarity: 'cosine' },
              { type: 'filter', path: 'user_id' },
              { type: 'filter', path: 'doc_id' },
            ],
          },
        },
      ],
    });
    log.info('vector_index_created', { name: config.mongo.vectorIndex });
    return { vector: 'created' };
  } catch (err) {
    // Already present, or not an Atlas cluster. Both are survivable: the
    // backend check at query time is what decides which path runs.
    log.warn('vector_index_unavailable', { err: String(err.message).slice(0, 160) });
    return { vector: 'unavailable', reason: String(err.message).slice(0, 160) };
  }
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    connecting = null;
  }
}
