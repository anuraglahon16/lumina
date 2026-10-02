import express from 'express';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { errorHandler, HttpError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { flushAll } from './store/jsonStore.js';
import { queryRouter } from './routes/query.js';
import { threadsRouter } from './routes/threads.js';
import { memoriesRouter } from './routes/memories.js';
import { documentsRouter } from './routes/documents.js';
import { observabilityRouter } from './routes/observability.js';
import { contractRouter } from './routes/contract.js';
import { jobQueue } from './services/jobs.js';
import { warmMongoPool } from './store/mongo.js';
import { probeVectorIndexes } from './services/vectorStore.js';
import './services/ingest.js'; // registers the index_document job handler

const log = createLogger('agent');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

/**
 * The agent service sits behind the gateway. It trusts the identity headers the
 * gateway sets, and when INTERNAL_TOKEN is configured it refuses anything that
 * did not come through it.
 */
/**
 * The route, with ids normalised out, so an arrival line groups with the
 * gateway's line for the same request rather than being its own group.
 */
function routeOf(req) {
  return (
    req.path
      .split('/')
      .map((seg) => (/^[a-z]{3,4}_[A-Za-z0-9]{6,}$/.test(seg) || /^[0-9a-f]{24,}$/i.test(seg) ? ':id' : seg))
      .join('/') || '/'
  );
}

app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || newId('req');
  req.userId = req.get('x-user-id') || 'anonymous';
  res.set('x-request-id', req.requestId);

  /**
   * Arrival, logged synchronously before anything can await.
   *
   * Four asks in a deployed benchmark left no run record at all: they stopped
   * before the agent persisted anything, and with only a completion log there
   * was no way to tell "never arrived" from "arrived and died". The run record
   * is written at finish; this line is written at entry, so the two together
   * bracket where a request was lost. Before the token check as well, since a
   * rejected request is also one that arrived.
   */
  log.info('request_arrived', { request_id: req.requestId, user_id: req.userId, method: req.method, route: routeOf(req) });

  if (process.env.INTERNAL_TOKEN && req.path !== '/v1/health') {
    if (req.get('x-internal-token') !== process.env.INTERNAL_TOKEN) {
      return next(new HttpError(403, 'forbidden', 'Agent service is only reachable through the gateway'));
    }
  }

  const started = performance.now();
  res.on('finish', () => {
    log.info('request', {
      request_id: req.requestId,
      user_id: req.userId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
    });
  });
  next();
});

app.use('/v1', queryRouter);
app.use('/v1', threadsRouter);
app.use('/v1', memoriesRouter);
app.use('/v1', documentsRouter);
app.use('/v1', observabilityRouter);

// The assignment's API, served at the paths its contract names. The gateway
// forwards these through unchanged; `/v1` stays this project's own surface.
app.use('/contract', contractRouter);

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));
app.use(errorHandler(log));

const host = process.env.AGENT_HOST || '127.0.0.1';
// Jobs left running by a previous process are reconciled once the store is
// reachable, rather than in a constructor that cannot await.
jobQueue.reconcile().catch((err) => log.warn('job_reconcile_failed', { err: err.message }));

/**
 * Ask the vector indexes, once, whether they can be queried at all.
 *
 * `/health` is read by the benchmark before it asks anything, so without this the
 * header of every run recorded an untested claim - and the claim was the
 * configured value, which was wrong: the index the code named did not exist, and
 * a `$vectorSearch` against a missing index returns nothing rather than failing.
 *
 * Deliberately not awaited and never fatal. Retrieval still works by scanning, so
 * refusing to boot would turn a degraded search into an outage.
 */
/**
 * Warm the connection pool before the first request, then probe the indexes.
 *
 * Sequenced deliberately: the probe needs a connection, so warming first means
 * the probe is measuring the index rather than a handshake. Neither blocks the
 * listener and neither can stop the agent starting.
 */
warmMongoPool()
  .then((status) => log.info('mongo_pool', { status }))
  .catch((err) => log.warn('mongo_pool_threw', { err: err.message }));

probeVectorIndexes()
  .then((status) => log.info('vector_probe', { status }))
  .catch((err) => log.warn('vector_probe_threw', { err: err.message }));

const server = app.listen(config.agent.port, host, () => {
  log.info('agent_listening', {
    // The port actually bound, not the one configured. With AGENT_PORT=0 the
    // OS chooses, and reporting the configured 0 tells a reader - or a test
    // waiting to connect - nothing about where the service is.
    port: server.address()?.port ?? config.agent.port,
    host,
    model: config.llm.model,
    llm_configured: Boolean(config.llm.apiKey),
    data_dir: config.agent.dataDir,
  });
});

let shuttingDown = false;

/**
 * Drain rather than stop dead.
 *
 * A platform sends SIGTERM and then SIGKILL after a grace period, so every
 * redeploy lands here. Exiting immediately cuts in-flight runs with no error
 * event to the client and can lose the run-log entry that was about to be
 * written. So: stop accepting connections, give live work a bounded chance to
 * finish, flush, and keep a hard timer so a wedged request cannot stop the
 * process exiting at all.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const graceMs = config.agent.shutdownGraceMs;
  log.info('shutting_down', { signal, grace_ms: graceMs });

  // The backstop runs whatever happens below, and never holds the loop open.
  const hardExit = setTimeout(() => {
    log.warn('shutdown_forced', { after_ms: graceMs });
    process.exit(0);
  }, graceMs);
  hardExit.unref?.();

  await new Promise((resolve) => server.close(resolve));

  // Background indexing is not tied to a connection, so closing the server does
  // not wait for it.
  const deadline = Date.now() + graceMs;
  while (jobQueue.running > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (jobQueue.running > 0) log.warn('shutdown_jobs_unfinished', { running: jobQueue.running });

  await flushAll();
  log.info('shutdown_complete', { signal });
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { err: err?.message, stack: err?.stack }));

export { app };
