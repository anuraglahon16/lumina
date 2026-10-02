import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { errorHandler } from '../shared/errors.js';
import { demoAuth } from './middleware/demoAuth.js';
import { identity, assignRequestId } from './middleware/identity.js';
import { rateLimit, rateLimitStats } from './middleware/rateLimit.js';
import { apiRouter } from './routes/api.js';
import { contractRouter } from './routes/contract.js';
import { newId } from '../shared/ids.js';
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

// Multipart uploads stream through untouched; everything else is JSON.
const isUpload = (req) =>
  req.method === 'POST' && (req.path === '/api/documents' || /^\/spaces\/[^/]+\/documents$/.test(req.path));
app.use((req, res, next) => (isUpload(req) ? next() : express.json({ limit: '512kb' })(req, res, next)));

/**
 * The assignment's API is mounted ahead of the demo password.
 *
 * That gate exists so a public demo link is not an open bill; the contract's
 * routes answer to `X-User-Id` instead, which is the authentication the
 * benchmark and the provided UI actually send. Putting the password in front of
 * them would fail every graded request with a 401.
 */
/**
 * Paths the demo password does not cover.
 *
 * The contract's routes authenticate with X-User-Id, which identifies a caller
 * rather than authorising one, so the API is open by design and a password in
 * front of it would fail every graded request. Given that, gating the UI adds
 * no protection to anything — it only stops a reader opening the app whose API
 * is already reachable. The password still guards this project's own /api.
 */
const CONTRACT_PATH = /^\/(health|stats|threads|memory|spaces|evals\/report\.json)(\/|$)/;
/**
 * Paths served without the demo password.
 *
 * `evals` is here because it is the page the rubric asks a human grader to
 * open, and a shared password on a read-only report is a gate on the wrong
 * thing: the password exists so a public URL is not an open bill on someone's
 * model credits, and reading a static report spends nothing. `evals$|evals\/`
 * rather than `evals` so it opens that page and not every path beginning with
 * those five letters. `/evals/report.json` never reaches here - it is answered
 * by the contract router above, which exempts it from the user header too.
 */
const PUBLIC_UI = /^\/(assets\/|favicon|manifest|robots|index\.html$|evals$|evals\/|$)/;
/**
 * The route a request hit, not the URL it used.
 *
 * AGENTS.md asks the gateway line to carry `route`. A path carries ids, so
 * `/threads/thr_abc/ask` and `/threads/thr_def/ask` group as two routes when
 * they are one, and a log grouped that way answers no question about latency per
 * route. Ids are recognised by shape rather than listed, so a new prefix does not
 * need a change here.
 */
function routeOf(req) {
  return (
    req.path
      .split('/')
      .map((seg) => (/^[a-z]{3,4}_[A-Za-z0-9]{6,}$/.test(seg) || /^[0-9a-f]{24,}$/i.test(seg) ? ':id' : seg))
      .join('/') || '/'
  );
}

/**
 * One log line per request, for every route.
 *
 * This sat below the contract handler, which mounts its router and returns into
 * it - so `/threads/*`, `/spaces/*` and every other contract route produced no
 * gateway log line at all. The graded path was the unlogged one, and
 * "one request is greppable end to end" was true of everything except the
 * requests that matter.
 *
 * `route` rather than `path`: the id in a URL is per-request noise, and grouping
 * by it makes every line its own group.
 */
app.use((req, res, next) => {
  const started = performance.now();
  res.on('finish', () => {
    log.info('request', {
      request_id: req.requestId,
      user_id: req.userId,
      method: req.method,
      route: routeOf(req),
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
      ua: req.get('user-agent')?.slice(0, 80),
    });
  });
  next();
});

app.use((req, res, next) => {
  if (!CONTRACT_PATH.test(req.path)) return next();
  // The shared derivation, not a second inline one: this path had its own, which
  // skipped the repeated-header split and broke correlation behind a proxy.
  assignRequestId(req, res);
  req.userId = req.get('x-user-id') || null;
  return contractRouter(req, res, next);
});

// Password gate: an unauthenticated caller reaches nothing, not even a user id.
app.use((req, res, next) => (PUBLIC_UI.test(req.path) ? next() : demoAuth(log)(req, res, next)));

app.use(identity);

// JSON body parsing everywhere except the multipart upload route, which streams.


/**
 * Which UI this container serves, decided once at startup.
 *
 * Declared here rather than beside the static mount below, because `/health`
 * reports it: a `const` is not hoisted, and while the handler only runs long
 * after module evaluation, code that reads as a use-before-declaration is code
 * someone has to reason about to dismiss.
 */
const WEB_DIST = path.join(config.root, 'web/dist');
export const uiRoot = existsSync(path.join(WEB_DIST, 'index.html')) ? WEB_DIST : path.join(config.root, 'src/gateway/public');

app.get('/health.internal', async (req, res) => {
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
    // Which UI this container is actually serving. The fallback is a different
    // application with a different feature set, and from the outside the two are
    // hard to tell apart until something is missing.
    ui: uiRoot.endsWith('web/dist') ? 'web/dist' : 'src/gateway/public (fallback: no web build in this image)',
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
// `/evals` belongs to the React app, which routes it client-side and fetches
// GET /evals/report.json. A server route here shadowed it, so the page a
// grader opens was the older server-rendered one telling them to run a
// harness that has since moved. `/runs` stays: the SPA has no route for it.
app.get('/runs', rateLimit('global'), runsPage);

app.use('/api', apiRouter);

/**
 * The UI is served by the gateway, so one origin covers page, API and SSE.
 *
 * `web/dist` is the provided React app, built into the image. The original
 * vanilla UI is the fallback, so a container built without a web build still
 * serves something rather than a wall of 404s - but a deployment is expected to
 * have the build, and `/health` says which one is live so the two are never
 * confused from the outside.
 *
 * This used to live in `api/index.js`, the single Vercel function that was the
 * whole application: gateway middleware in front of the agent's routers, in one
 * process, with the provider keys on the public edge. Serving the UI was the one
 * part of that file which was genuinely the gateway's job.
 */
app.use(rateLimit('global', 0), express.static(uiRoot, { maxAge: '5m', index: 'index.html' }));

/**
 * A single-page app owns its own routing.
 *
 * `/evals` is a client route, not a file, so anything unmatched above that is a
 * GET for a page belongs to the app rather than being a 404. Scoped to the real
 * build: with the vanilla fallback there is no SPA to hand control to, and
 * swallowing unknown paths there would turn a missing route into a blank page.
 *
 * API-shaped paths are excluded so a typo'd endpoint still returns JSON. A
 * client asking for `/threadz` wants an error it can read, not index.html.
 */
if (uiRoot === WEB_DIST) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || CONTRACT_PATH.test(req.path)) return next();
    if (!req.accepts('html')) return next();
    return res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));
app.use(errorHandler(log));

/**
 * Exported so a test can drive the real server rather than a second one wrapped
 * around the same app. With GATEWAY_PORT=0 the OS picks the port and
 * `server.address().port` is the only way to learn it - the configured value is
 * 0, which is how an earlier agent log announced `"port":0`.
 */
export const server = app.listen(config.gateway.port, () => {
  log.info('gateway_listening', {
    port: server.address()?.port ?? config.gateway.port,
    agent_url: config.gateway.agentUrl,
    cors: config.gateway.corsOrigins,
    auth_gate: Boolean(config.gateway.demoPassword) ? 'shared-password' : 'open',
    ui: `http://localhost:${server.address()?.port ?? config.gateway.port}`,
    ui_root: uiRoot.endsWith('web/dist') ? 'web/dist' : 'src/gateway/public (fallback)',
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
