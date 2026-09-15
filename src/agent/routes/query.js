import express from 'express';
import { z } from 'zod';
import { openSse } from '../../shared/sse.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { runQuickQuery } from '../core/quick.js';
import { runDeepQuery } from '../core/deep.js';
import { createRunStream, getRunStream } from '../services/runStreams.js';
import { jobQueue } from '../services/jobs.js';
import { newId } from '../../shared/ids.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent.query');

const querySchema = z.object({
  query: z.string().trim().min(3).max(2000),
  mode: z.enum(['quick', 'deep']).default('quick'),
  thread_id: z.string().optional(),
  async: z.boolean().optional(),
});

export const queryRouter = express.Router();

/**
 * POST /v1/query. Streams a run over SSE.
 *
 * Quick and Deep are dispatched to entirely separate orchestrators; there is no
 * shared "mode" branch inside a single loop, and neither can turn into the other.
 */
queryRouter.post('/query', async (req, res, next) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) return next(badRequest('Invalid query request', parsed.error.flatten()));
  const { query, mode, thread_id: threadId, async: detached } = parsed.data;
  const userId = req.userId;

  if (detached) {
    // Detached Deep Search: return a handle, stream it later.
    const streamId = newId('strm');
    const stream = createRunStream(streamId);
    const job = await jobQueue.enqueue('agent_run', { query, mode, threadId, userId, requestId: req.requestId, streamId }, { userId });
    return res.status(202).json({
      job_id: job.id,
      stream_id: streamId,
      stream_url: `/v1/runs/stream/${streamId}`,
      status: 'queued',
      mode,
    });
  }

  const sse = openSse(res, { requestId: req.requestId });
  const controller = new AbortController();
  // Client disconnect is a *response* close before we finished writing,
  // `req` closes as soon as its body is parsed, which is not a disconnect.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let reportedError = false;
  const emit = (event, data) => {
    if (event === 'error') reportedError = true;
    sse.send(event, data);
  };
  const runner = mode === 'deep' ? runDeepQuery : runQuickQuery;

  try {
    await runner({ query, userId, threadId, requestId: req.requestId, emit, signal: controller.signal });
  } catch (err) {
    log.error('run_failed', { request_id: req.requestId, mode, err: err.message });
    // The orchestrators emit their own `error`/`done`; only report what they missed.
    if (!reportedError) sse.send('error', { code: err.code || 'agent_error', message: err.message });
  } finally {
    sse.close();
  }
});

/** GET /v1/runs/stream/:streamId. Replay, then follow a detached run. */
queryRouter.get('/runs/stream/:streamId', (req, res, next) => {
  const stream = getRunStream(req.params.streamId);
  if (!stream) return next(notFound('No such run stream (it may have expired)'));

  const sse = openSse(res, { requestId: req.requestId });
  const fromSeq = Number(req.headers['last-event-id'] || req.query.from || 0);
  const unsubscribe = stream.subscribe((entry) => {
    if (entry.event === '_closed') {
      sse.close();
      return;
    }
    sse.send(entry.event, entry.data);
  }, fromSeq);

  res.on('close', () => {
    unsubscribe();
    sse.close();
  });
});

// Background variant of a run, used by `async: true`.
jobQueue.register('agent_run', async ({ query, mode, threadId, userId, requestId, streamId }) => {
  const stream = getRunStream(streamId) || createRunStream(streamId);
  const emit = (event, data) => stream.push(event, data);
  try {
    const runner = mode === 'deep' ? runDeepQuery : runQuickQuery;
    const result = await runner({ query, userId, threadId, requestId, emit });
    return { run_id: result.run.id, thread_id: result.thread_id, sources: result.sources.length };
  } finally {
    stream.close();
  }
});
