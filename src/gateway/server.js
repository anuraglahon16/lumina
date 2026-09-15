import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { errorHandler } from '../shared/errors.js';
import { demoAuth } from './middleware/demoAuth.js';
import { identity } from './middleware/identity.js';
import { rateLimit, rateLimitStats } from './middleware/rateLimit.js';
import { apiRouter } from './routes/api.js';
import { evalsPage } from './routes/evals.js';
import { runsPage } from './routes/runs.js';

const log = createLogger('gateway');
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

// Basic hardening for the served UI.
//
// Framing is controlled by FRAME_ANCESTORS. The default denies everything,
// which is right for a standalone deployment; a host that renders the app
// inside its own page needs its origin listed instead. `frame-ancestors` is
// used rather than x-frame-options because it accepts an allowlist, and the
// legacy header is only sent for the deny case, where the two agree.
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

// Password gate first: an unauthenticated caller reaches nothing, not even a user id.
app.use(demoAuth(log));

app.use(identity);

// JSON body parsing everywhere except the multipart upload route, which streams.
app.use((req, res, next) => (req.path === '/api/documents' && req.method === 'POST' ? next() : express.json({ limit: '512kb' })(req, res, next)));

app.use((req, res, next) => {
  const started = performance.now();
  res.on('finish', () => {
    log.info('request', {
      request_id: req.requestId,
      user_id: req.userId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
      ua: req.get('user-agent')?.slice(0, 80),
    });
  });
  next();
});

app.get('/health', async (req, res) => {
  let agent = { status: 'unreachable' };
  try {
    const upstream = await fetch(new URL('/v1/health', config.gateway.agentUrl), { signal: AbortSignal.timeout(3000) });
    agent = await upstream.json();
  } catch (err) {
    agent = { status: 'unreachable', error: err.message };
  }
  res.status(agent.status === 'unreachable' ? 503 : 200).json({
    status: agent.status === 'unreachable' ? 'degraded' : agent.status,
    service: 'gateway',
    uptime_s: Math.round(process.uptime()),
    agent,
  });
});

/** What the limiter actually did, so limits can be tuned from evidence. */
app.get('/api/limits', (req, res) => {
  res.json({
    identity: config.gateway.authSecret ? 'signed' : 'unsigned',
    classes: rateLimitStats(),
  });
});

// The evaluation report travels with the deployment rather than living in a
// terminal nobody can see.
app.get('/evals', rateLimit('global'), evalsPage);
app.get('/runs', rateLimit('global'), runsPage);

app.use('/api', apiRouter);

// The UI is served by the gateway so one origin covers page, API, and SSE.
app.use(rateLimit('global', 0), express.static(path.join(config.root, 'src/gateway/public'), { maxAge: '5m', index: 'index.html' }));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));
app.use(errorHandler(log));

const server = app.listen(config.gateway.port, () => {
  log.info('gateway_listening', {
    port: config.gateway.port,
    agent_url: config.gateway.agentUrl,
    cors: config.gateway.corsOrigins,
    auth_gate: Boolean(config.gateway.demoPassword) ? 'shared-password' : 'open',
    ui: `http://localhost:${config.gateway.port}`,
  });
});

const shutdown = (signal) => {
  log.info('shutting_down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };
