import express from 'express';
import { Readable } from 'node:stream';
import { config } from '../../shared/config.js';
import { upstreamError, HttpError } from '../../shared/errors.js';
import { createLogger } from '../../shared/logger.js';
import { forwardJson } from './proxy.js';

/**
 * The assignment's API at the gateway.
 *
 * The gateway's job here is the edge and nothing else: identity, validation,
 * rate limits, and passing the stream through. The answer is composed in the
 * agent service, which is also the only place provider keys exist, so every one
 * of these routes is a forward rather than an implementation.
 *
 * `X-User-Id` is required on every route except `GET /health`, and the check
 * lives here rather than in the agent because it is an edge concern — the agent
 * trusts what the gateway hands it.
 */

const log = createLogger('gateway.contract');
export const contractRouter = express.Router();

const AGENT = (path) => new URL(path, config.gateway.agentUrl);

function requireUser(req, res, next) {
  if (!req.get('x-user-id')) {
    return next(new HttpError(401, 'unauthorized', 'X-User-Id header is required'));
  }
  next();
}

/**
 * Stream the agent's SSE through untouched.
 *
 * Byte-for-byte, because the frames are already in the contract's shape and
 * re-encoding them here would put a second author between the engine and the
 * grader. Buffering is disabled the whole way down: an answer that arrives
 * complete at the end is not a stream, and time-to-first-token is measured on
 * the client.
 */
contractRouter.post('/threads/:threadId/ask', requireUser, async (req, res, next) => {
  const target = AGENT(`/contract/threads/${encodeURIComponent(req.params.threadId)}/ask`);
  const controller = new AbortController();
  // The client leaving closes the response; the request stream has already ended
  // once the body was parsed, so listening there aborts immediately.
  res.on('close', () => controller.abort());

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': req.requestId,
        'x-user-id': req.userId,
        ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
      signal: controller.signal,
    });

    if (!upstream.ok && !upstream.headers.get('content-type')?.includes('text/event-stream')) {
      const text = await upstream.text();
      res.status(upstream.status).set('content-type', upstream.headers.get('content-type') || 'application/json');
      return res.send(text);
    }

    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': req.requestId,
    });
    res.flushHeaders?.();

    await Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return; // the client left; nothing to report
    log.error('contract_ask_forward_failed', { request_id: req.requestId, err: err.message });
    if (!res.headersSent) return next(upstreamError('The agent service is unreachable', { cause: err.message }));
    res.end();
  }
});

/* ------------------------------------------------------- plain forwards */

const forward = (path) => (req, res, next) => forwardJson(req, res, next, { path: typeof path === 'function' ? path(req) : path });

contractRouter.post('/threads', requireUser, forward('/contract/threads'));
contractRouter.get('/threads', requireUser, forward('/contract/threads'));
contractRouter.get('/threads/:threadId', requireUser, forward((req) => `/contract/threads/${encodeURIComponent(req.params.threadId)}`));
contractRouter.get('/memory', requireUser, forward('/contract/memory'));
contractRouter.delete('/memory/:memoryId', requireUser, forward((req) => `/contract/memory/${encodeURIComponent(req.params.memoryId)}`));
contractRouter.post('/spaces', requireUser, forward('/contract/spaces'));
contractRouter.get('/spaces', requireUser, forward('/contract/spaces'));
contractRouter.get('/spaces/:spaceId/documents', requireUser, forward((req) => `/contract/spaces/${encodeURIComponent(req.params.spaceId)}/documents`));
contractRouter.get('/stats', requireUser, forward('/contract/stats'));

/**
 * The upload streams through as multipart rather than being parsed here.
 *
 * Parsing 25MB at the edge only to re-encode it for the next hop would put the
 * whole file in the gateway's memory and add its own latency to a route the SLA
 * gives 300ms.
 */
contractRouter.post('/spaces/:spaceId/documents', requireUser, async (req, res, next) => {
  const target = AGENT(`/contract/spaces/${encodeURIComponent(req.params.spaceId)}/documents`);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': req.get('content-type') || 'application/octet-stream',
        'x-request-id': req.requestId,
        'x-user-id': req.userId,
        ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
      },
      body: Readable.toWeb(req),
      duplex: 'half',
      signal: AbortSignal.timeout(120000),
    });
    const text = await upstream.text();
    res.status(upstream.status).set('content-type', upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    log.error('contract_upload_failed', { request_id: req.requestId, err: err.message });
    next(upstreamError('The agent service is unreachable', { cause: err.message }));
  }
});

/**
 * Health is the one route with no identity check, and it nests the agent's own
 * under `ai` so a single call says whether the whole stack is up.
 */
contractRouter.get('/health', async (req, res) => {
  let ai = { status: 'down' };
  let body = null;
  try {
    const upstream = await fetch(AGENT('/contract/health'), { signal: AbortSignal.timeout(3000) });
    body = await upstream.json();
    ai = { status: body.status === 'ok' ? 'ok' : 'down' };
  } catch {
    ai = { status: 'down' };
  }

  res.json({
    status: body && body.status === 'ok' ? 'ok' : 'degraded',
    model: body?.model ?? 'unknown',
    searchProvider: body?.searchProvider ?? 'none',
    vectorStore: body?.vectorStore ?? 'none',
    db: body?.db ?? 'down',
    ai,
    version: body?.version ?? '1.0.0',
  });
});
