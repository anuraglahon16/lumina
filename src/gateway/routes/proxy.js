import { Readable } from 'node:stream';
import { config } from '../../shared/config.js';
import { upstreamError } from '../../shared/errors.js';
import { parseSseStream } from '../../shared/sse.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('gateway.proxy');

function headersFor(req, extra = {}) {
  return {
    'x-request-id': req.requestId,
    'x-user-id': req.userId,
    ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
    ...extra,
  };
}

/** Forward a JSON request to the agent service and relay its response verbatim. */
export async function forwardJson(req, res, next, { path, method = req.method, body } = {}) {
  const target = new URL(path || req.originalUrl.replace(/^\/api/, '/v1'), config.gateway.agentUrl);
  try {
    const upstream = await fetch(target, {
      method,
      headers: headersFor(req, method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? req.body ?? {}),
      signal: AbortSignal.timeout(60000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('content-type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    log.error('forward_failed', { request_id: req.requestId, target: target.pathname, err: err.message });
    next(upstreamError('The agent service is unreachable', { target: target.pathname, cause: err.message }));
  }
}

/**
 * Forward an SSE run.
 *
 * The gateway does not merely pipe bytes: it parses events as they pass so it
 * can log the run's shape (first source, first token, termination reason) and
 * so a mid-stream upstream failure still reaches the client as an `error`
 * event rather than a silently truncated stream.
 */
export async function forwardSse(req, res, next, { path, body, method = 'POST' } = {}) {
  const target = new URL(path || req.originalUrl.replace(/^\/api/, '/v1'), config.gateway.agentUrl);
  const controller = new AbortController();
  // Abort on *response* close, not request close: an Express request stream
  // ends as soon as its body is parsed, which would cancel every run instantly.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers: headersFor(req, { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), accept: 'text/event-stream' }),
      body: method === 'POST' ? JSON.stringify(body ?? req.body ?? {}) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    return next(upstreamError('Could not reach the agent service', { cause: err.message }));
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(detail);
    } catch {
      /* not JSON */
    }
    res.status(upstream.status);
    return res.json(parsed || { error: { code: 'upstream_error', message: detail.slice(0, 500) || 'Agent service error' } });
  }

  res.status(200);
  res.set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': req.requestId,
  });
  res.flushHeaders?.();

  const observed = { started: performance.now(), sources_at_ms: null, first_token_at_ms: null, events: 0, run_id: null, termination: null };

  try {
    for await (const { event, data } of parseSseStream(upstream.body)) {
      observed.events += 1;
      if (event === 'run_start') observed.run_id = data.run_id;
      if (event === 'sources' && observed.sources_at_ms === null) observed.sources_at_ms = Math.round(performance.now() - observed.started);
      if (event === 'token' && observed.first_token_at_ms === null) observed.first_token_at_ms = Math.round(performance.now() - observed.started);
      if (event === 'done') observed.termination = data.termination_reason;

      if (res.writableEnded) break;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      log.error('sse_forward_failed', { request_id: req.requestId, err: err.message });
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'stream_interrupted', message: err.message })}\n\n`);
      }
    }
  } finally {
    log.info('sse_run_forwarded', {
      request_id: req.requestId,
      user_id: req.userId,
      run_id: observed.run_id,
      events: observed.events,
      sources_at_ms: observed.sources_at_ms,
      first_token_at_ms: observed.first_token_at_ms,
      // The invariant the whole design rests on; logged so a regression is visible.
      sources_before_tokens:
        observed.sources_at_ms !== null && observed.first_token_at_ms !== null
          ? observed.sources_at_ms <= observed.first_token_at_ms
          : null,
      termination_reason: observed.termination,
      aborted: controller.signal.aborted,
    });
    if (!res.writableEnded) res.end();
  }
}

/** Stream a multipart upload straight through without buffering it twice. */
export async function forwardUpload(req, res, next) {
  const target = new URL('/v1/documents', config.gateway.agentUrl);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: headersFor(req, { 'content-type': req.get('content-type') }),
      body: Readable.toWeb(req),
      duplex: 'half',
      signal: AbortSignal.timeout(120000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('content-type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    log.error('upload_forward_failed', { request_id: req.requestId, err: err.message });
    next(upstreamError('Upload could not be forwarded to the agent service', { cause: err.message }));
  }
}
