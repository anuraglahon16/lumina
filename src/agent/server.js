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
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || newId('req');
  req.userId = req.get('x-user-id') || 'anonymous';
  res.set('x-request-id', req.requestId);

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

const server = app.listen(config.agent.port, host, () => {
  log.info('agent_listening', {
    port: config.agent.port,
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
