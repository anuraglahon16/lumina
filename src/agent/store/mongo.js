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
      /**
       * Keep connections open, because establishing one is expensive here.
       *
       * Measured from the deployed agent: an established pooled round-trip costs
       * roughly fifteen milliseconds, and opening a NEW connection to this
       * cluster costs between 104 and 376. The upload path makes three database
       * calls inside a 300ms budget, so one cold connection in the middle of it
       * is the whole budget - which is exactly what two of eight deployed
       * uploads did, at 411ms and 478ms server-side while the median was 74.
       *
       * `minPoolSize` keeps that many connections established from startup, so a
       * request finds one rather than paying for one. `maxIdleTimeMS: 0` is the
       * driver default and means "never reap for idleness"; it is written out
       * because the whole point here is that idle connections must survive.
       */
      const c = new MongoClient(config.mongo.uri, {
        serverSelectionTimeoutMS: 5000,
        minPoolSize: config.mongo.minPoolSize,
        maxPoolSize: config.mongo.maxPoolSize,
        maxIdleTimeMS: 0,
      });
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

/**
 * Open the pool before the first request needs it.
 *
 * `minPoolSize` is filled in the background, so the first requests after boot
 * can still race ahead of it. Issuing that many concurrent pings forces the
 * connections to exist and, more usefully, makes a cluster that cannot be
 * reached a startup log line rather than a slow first upload.
 *
 * Never fatal: the agent runs without Mongo, and a cold pool is slow rather
 * than broken.
 */
export async function warmMongoPool() {
  if (!mongoEnabled()) return 'skipped: no MONGODB_URI';
  const started = Date.now();
  try {
    const db = await mongoDb();
    const n = Math.max(1, config.mongo.minPoolSize);
    await Promise.all(Array.from({ length: n }, () => db.command({ ping: 1 })));
    const ms = Date.now() - started;
    log.info('mongo_pool_warm', { connections: n, ms });
    startPoolKeepalive();
    return `ok: ${n} connection(s) in ${ms}ms`;
  } catch (err) {
    log.warn('mongo_pool_warm_failed', { err: err.message, ms: Date.now() - started });
    return `failed: ${err.message}`;
  }
}

let keepalive = null;

/**
 * Touch every pooled connection on a timer, so none of them goes stale.
 *
 * Warming the pool once was not enough. Measured over twenty deployed uploads,
 * server-side acceptance time was bimodal: either 40-50ms or 390-490ms, with
 * almost nothing in between. Three warm round trips cost about 45ms, and the
 * slow group is that plus one reconnect - the 104-376ms a new connection to this
 * cluster costs. So the pool was losing connections between requests even though
 * `maxIdleTimeMS: 0` tells the driver never to close one for idleness: something
 * on the other side - shared-tier proxy, NAT, or the server's own idle timeout -
 * was dropping them, and the driver only discovered it on the next operation.
 *
 * The driver's own heartbeat does not help: it monitors topology on separate
 * connections, not the pooled ones application operations use.
 *
 * `minPoolSize` concurrent pings, because a sequential ping touches one
 * connection and leaves the other four to rot. Cheap at this interval - a
 * handful of operations a minute - and the interval is unref'd so it never holds
 * the process open.
 */
export function startPoolKeepalive() {
  if (keepalive || !mongoEnabled() || config.mongo.keepaliveMs <= 0) return;
  const n = Math.max(1, config.mongo.minPoolSize);
  keepalive = setInterval(async () => {
    try {
      const db = await mongoDb();
      await Promise.all(Array.from({ length: n }, () => db.command({ ping: 1 })));
    } catch (err) {
      // A failed keepalive is not a failed request. The next real operation
      // will reconnect or fail on its own terms, and /health reports the state.
      log.warn('mongo_keepalive_failed', { err: err.message });
    }
  }, config.mongo.keepaliveMs);
  keepalive.unref?.();
  log.info('mongo_keepalive_started', { every_ms: config.mongo.keepaliveMs, connections: n });
}

export function stopPoolKeepalive() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
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
