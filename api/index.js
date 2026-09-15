import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';
import { errorHandler } from '../src/shared/errors.js';

import { demoAuth } from '../src/gateway/middleware/demoAuth.js';
import { identity } from '../src/gateway/middleware/identity.js';
import { rateLimit, rateLimitStats } from '../src/gateway/middleware/rateLimit.js';
import { evalsPage } from '../src/gateway/routes/evals.js';
import { runsPage } from '../src/gateway/routes/runs.js';

import { queryRouter } from '../src/agent/routes/query.js';
import { threadsRouter } from '../src/agent/routes/threads.js';
import { memoriesRouter } from '../src/agent/routes/memories.js';
import { documentsRouter } from '../src/agent/routes/documents.js';
import { observabilityRouter } from '../src/agent/routes/observability.js';
import '../src/agent/services/ingest.js'; // registers the index_document handler

/**
 * The whole application as one Vercel function.
 *
 * Normally this runs as two processes: a gateway that owns identity, rate
 * limiting and the UI, and an agent that owns the loop and the provider keys,
 * reachable only over loopback. That separation is a deployment property, not a
 * code one, and serverless gives you exactly one process, so here the gateway's
 * middleware runs in front of the agent's routers directly and the proxy hop
 * disappears.
 *
 * What genuinely changes, and is worth knowing before relying on it:
 *
 * - Background work does not outlive a response. A function is frozen once it
 *   returns, so document indexing runs inline (see ingest.js) rather than after
 *   a 202. Uploading a large PDF blocks for as long as it takes to index.
 * - Rate limits and circuit breakers are per instance. Vercel runs as many
 *   instances as it likes, so both become advisory rather than binding.
 * - Detached Deep Search cannot be resumed, because the replay buffer lives in
 *   the memory of whichever instance started the run.
 *
 * MongoDB is therefore not optional here: with the JSON store, every request
 * would land on an instance with its own empty disk.
 */

const log = createLogger('vercel');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(
  cors({
    origin: config.gateway.corsOrigins.includes('*') ? true : config.gateway.corsOrigins,
    credentials: true,
    exposedHeaders: ['x-request-id', 'x-user-id', 'x-lumina-token', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after'],
  }),
);

const denyFraming = config.gateway.frameAncestors === "'none'";
app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': `frame-ancestors ${config.gateway.frameAncestors}`,
  });
  if (denyFraming) res.set('x-frame-options', 'DENY');
  next();
});

app.use(demoAuth(log));
app.use(identity);

// Multipart uploads stream; everything else is JSON.
app.use((req, res, next) =>
  req.path.startsWith('/api/documents') && req.method === 'POST' ? next() : express.json({ limit: '512kb' })(req, res, next),
);

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () =>
    log.info('request', {
      request_id: req.requestId,
      user_id: req.userId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    }),
  );
  next();
});

app.get('/health', async (req, res) => {
  const { pingMongo, mongoEnabled } = await import('../src/agent/store/mongo.js');
  const { capabilities } = await import('../src/shared/config.js');
  const caps = capabilities();
  res.json({
    status: caps.llm ? 'ok' : 'degraded',
    service: 'lumina',
    platform: 'vercel',
    checks: {
      llm: caps.llm ? 'configured' : 'missing ANTHROPIC_API_KEY',
      store: mongoEnabled() ? 'mongodb' : 'json (ephemeral on serverless)',
      mongo: await pingMongo(),
    },
    model: config.llm.model,
  });
});

app.get('/api/limits', (req, res) => {
  res.json({
    identity: config.gateway.authSecret ? 'signed' : 'unsigned',
    // Per instance here, so treat these as a sample rather than a total.
    scope: 'instance',
    classes: rateLimitStats(),
  });
});

app.get('/evals', rateLimit('global'), evalsPage);
app.get('/runs', rateLimit('global'), runsPage);

// The agent's routers are mounted where the gateway used to forward to them, so
// the browser's URLs are unchanged.
const api = express.Router();
api.use((req, res, next) => rateLimit(req.body?.mode === 'deep' ? 'deep' : 'quick', req.path === '/query' ? 1 : 0)(req, res, next));
api.use(queryRouter);
api.use(threadsRouter);
api.use(memoriesRouter);
api.use(documentsRouter);
api.use(observabilityRouter);
app.use('/api', api);

app.use(rateLimit('global', 0), express.static(path.join(config.root, 'src/gateway/public'), { maxAge: '5m', index: 'index.html' }));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));
app.use(errorHandler(log));

export default app;
