import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { openSse } from '../../shared/sse.js';
import { badRequest, notFound, HttpError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { config, capabilities } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { contractStream, __testing as contractMap } from '../../gateway/contract/events.js';
import { runQuickQuery } from '../core/quick.js';
import { runDeepQuery } from '../core/deep.js';
import { createThread, getThread, listThreads, ensureThread } from '../services/threads.js';
import { listMemories, deleteMemory } from '../services/memoryStore.js';
import { listDocuments } from '../services/ragStore.js';
import { enqueueDocument } from '../services/ingest.js';
import { createSpace, listSpaces, getSpace } from '../services/spaces.js';
import { listRuns, runStats } from '../store/runLog.js';
import { pingMongo } from '../store/mongo.js';
import { resolveProviders } from '../services/search/index.js';

/**
 * The assignment's API, served alongside this project's own.
 *
 * `packages/contract/` is read-only and is the single definition of these
 * shapes; this file is the adapter onto an engine that was built before it and
 * names things differently. Where the two disagree the contract wins, because
 * the provided UI and the benchmark both parse against it and neither can be
 * edited.
 *
 * The existing `/api` routes are untouched. Two surfaces over one engine is a
 * smaller risk than one surface that has to satisfy two readers, and the older
 * one is what the deployed UI already talks to.
 */

const log = createLogger('agent.contract');
export const contractRouter = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const ACCEPTED = new Set(['application/pdf', 'text/markdown', 'text/plain']);

/** Ours on the left, the contract's five states on the right. */
const DOC_STATUS = {
  queued: 'pending',
  pending: 'pending',
  parsing: 'parsing',
  chunking: 'parsing',
  embedding: 'embedding',
  indexing: 'embedding',
  ready: 'indexed',
  indexed: 'indexed',
  failed: 'failed',
};

const askSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(['auto', 'web', 'docs']).default('auto'),
  depth: z.enum(['quick', 'deep']).default('quick'),
  spaceId: z.string().optional(),
});

/* ------------------------------------------------------------------ ask */

contractRouter.post('/threads/:threadId/ask', async (req, res, next) => {
  const parsed = askSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(badRequest('Invalid ask request', parsed.error.flatten()));
  const { query, mode, depth, spaceId } = parsed.data;
  const userId = req.userId;

  // The thread is addressed in the path, so it has to exist before the run
  // rather than being created by it.
  const thread = await ensureThread({ threadId: req.params.threadId, userId, title: query });

  const sse = openSse(res, { requestId: req.requestId });
  const controller = new AbortController();
  // The client leaving closes the response; the request stream has already ended
  // once the body was parsed, so listening there aborts immediately.
  res.on('close', () => controller.abort());

  const answerId = newId('ans');
  const emit = contractStream({ send: (event, data) => sse.send(event, data), depth, answerId });

  try {
    const run = depth === 'deep' ? runDeepQuery : runQuickQuery;
    await run({
      query,
      userId,
      threadId: thread.id,
      requestId: req.requestId,
      spaceId,
      // 'docs' and 'web' are the caller choosing where the answer comes from;
      // the toolset is narrowed accordingly rather than the prompt asking.
      retrievalMode: mode,
      emit,
      signal: controller.signal,
    });
  } catch (err) {
    log.error('contract_ask_failed', { request_id: req.requestId, err: err.message });
    // The stream already carried an `error` frame from the engine's own
    // handler; this only covers a throw before the run started emitting.
    if (!res.writableEnded) sse.send('error', { status: err.status || 502, error: err.message });
  } finally {
    sse.close();
  }
});

/* -------------------------------------------------------------- threads */

contractRouter.post('/threads', async (req, res, next) => {
  try {
    const thread = await createThread({ userId: req.userId, title: req.body?.title });
    res.status(201).json({ threadId: thread.id });
  } catch (err) {
    next(err);
  }
});

contractRouter.get('/threads', async (req, res, next) => {
  try {
    const { items } = await listThreads(req.userId, { limit: 50 });
    res.json({
      threads: items.map((t) => ({ threadId: t.id, title: t.title || 'Untitled', createdAt: t.created_at })),
    });
  } catch (err) {
    next(err);
  }
});

contractRouter.get('/threads/:threadId', async (req, res, next) => {
  try {
    const thread = await getThread(req.params.threadId, req.userId);
    if (!thread) return next(notFound('No such thread'));
    res.json({
      threadId: thread.id,
      title: thread.title || 'Untitled',
      messages: (thread.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.sources?.length ? { sources: m.sources.map(toContractSourceRow) } : {}),
        ...(m.run_id ? { answerId: m.run_id } : {}),
        ...(m.created_at ? { createdAt: m.created_at } : {}),
      })),
    });
  } catch (err) {
    next(err);
  }
});

function toContractSourceRow(s) {
  const kind = s.type === 'document' || s.type === 'doc' ? 'doc' : 'web';
  return {
    n: s.n,
    kind,
    title: s.title || s.url || `Source ${s.n}`,
    snippet: (s.snippet || '').trim() || (s.title || 'No excerpt available.'),
    ...(kind === 'web' ? { url: s.url } : { docId: s.doc_id || s.docId }),
    ...(contractMap.toLocator(s.locator) ? { locator: contractMap.toLocator(s.locator) } : {}),
  };
}

/* --------------------------------------------------------------- memory */

contractRouter.get('/memory', async (req, res, next) => {
  try {
    const { items } = await listMemories(req.userId, { limit: 200 });
    res.json({
      memories: items.map((m) => ({
        id: m.id,
        text: m.content,
        ...(m.thread_id ? { sourceThread: m.thread_id } : {}),
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

contractRouter.delete('/memory/:memoryId', async (req, res, next) => {
  try {
    const removed = await deleteMemory(req.params.memoryId, req.userId);
    if (!removed) return next(notFound('No such memory'));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- spaces */

contractRouter.post('/spaces', async (req, res, next) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 120) return next(badRequest('name is required (1-120 characters)'));
  try {
    const space = await createSpace({ userId: req.userId, name });
    res.status(201).json({ spaceId: space.id, name: space.name });
  } catch (err) {
    next(err);
  }
});

contractRouter.get('/spaces', async (req, res, next) => {
  try {
    const { items } = await listSpaces(req.userId, { limit: 100 });
    res.json({ spaces: items.map((s) => ({ spaceId: s.id, name: s.name, createdAt: s.created_at })) });
  } catch (err) {
    next(err);
  }
});

/**
 * Upload accepts and returns immediately.
 *
 * The SLA gives this 300ms at p95, which rules out parsing, chunking or
 * embedding on the request. All that happens here is a size and type check and
 * a queued job; the worker moves the document through
 * pending → parsing → embedding → indexed, and the list route is where progress
 * is read.
 */
contractRouter.post('/spaces/:spaceId/documents', upload.single('file'), async (req, res, next) => {
  try {
    const space = await getSpace(req.params.spaceId, req.userId);
    if (!space) return next(notFound('No such space'));
    if (!req.file) return next(badRequest('a file is required'));
    if (!ACCEPTED.has(req.file.mimetype)) {
      return next(new HttpError(415, 'unsupported_media_type', `Accepted types: ${[...ACCEPTED].join(', ')}`));
    }

    // Accepting is one write and a handle. The SLA gives this route 300ms at
    // p95 and the database is remote, so every round trip that is not needed to
    // answer "yes, I have it" happens after the answer: queueing the job and
    // recording its id are the worker's business, not the uploader's.
    const accepted = enqueueDocument({
      userId: req.userId,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer: req.file.buffer,
      spaceId: space.id,
      onAccepted: (doc) => res.status(202).json({ docId: doc.id, status: 'pending' }),
    });
    if (config.runtime.serverless) await accepted;
    else accepted.catch((err) => log.error('contract_ingest_failed', { request_id: req.requestId, err: err.message }));
  } catch (err) {
    next(err);
  }
});

contractRouter.get('/spaces/:spaceId/documents', async (req, res, next) => {
  try {
    const space = await getSpace(req.params.spaceId, req.userId);
    if (!space) return next(notFound('No such space'));
    const { items } = await listDocuments(req.userId, { limit: 200 });
    res.json({
      documents: items
        .filter((d) => d.space_id === space.id)
        .map((d) => ({
          docId: d.id,
          title: d.filename || d.title || d.id,
          // `stage` is the live state; `status` only says queued/processing/done,
          // and the contract's five values line up with the stages.
          status: DOC_STATUS[d.status === 'processing' ? d.stage : d.status] ?? 'pending',
          // Stored as a fraction, reported as a percentage.
          pct: Math.max(0, Math.min(100, Math.round((d.progress ?? 0) * 100))),
          ...(d.page_count ? { pages: d.page_count } : {}),
          ...(typeof d.chunk_count === 'number' ? { chunks: d.chunk_count } : {}),
          ...(d.error ? { error: d.error } : {}),
        })),
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------- health & stats */

contractRouter.get('/health', async (req, res) => {
  const caps = capabilities();
  const db = (await pingMongo()) === 'ok' ? 'ok' : 'down';
  res.json({
    status: caps.llm && db === 'ok' ? 'ok' : 'degraded',
    // The contract wants one name, so it gets the model that writes answers;
    // the full split is alongside it, since a cost figure is not interpretable
    // without knowing which model produced which part of the run.
    model: config.llm.quickModel,
    models: {
      quick: config.llm.quickModel,
      planner: config.llm.plannerModel,
      branch: config.llm.branchModel,
      deep_synthesis: config.llm.deepSynthesisModel,
      query_rewrite: config.llm.queryRewriteModel,
      memory: config.llm.memoryModel,
    },
    // The provider actually first in line, not merely one that is configured:
    // a recall or latency number is not comparable without knowing which.
    searchProvider: resolveProviders()[0] || 'none',
    vectorStore: config.vector?.backend || 'mongo-cosine-scan',
    db,
    version: '1.0.0',
  });
});

contractRouter.get('/stats', async (req, res, next) => {
  try {
    const stats = await runStats({ userId: req.userId });
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { items } = await listRuns({ userId: req.userId }, { limit: 1000 });
    const today = items.filter((r) => (r.started_at || '') >= since);
    res.json({
      requests: stats.runs ?? 0,
      answers: stats.runs ?? 0,
      searchCacheHitRatePct: Math.round((stats.cache_hit_rate ?? 0) * 100),
      ttftP95Ms: stats.ttft_ms?.p95 ?? 0,
      costUsdToday: Number(today.reduce((a, r) => a + (r.cost_usd || 0), 0).toFixed(6)),
      deepToday: today.filter((r) => r.mode === 'deep').length,
      deepDailyCap: config.limits?.deepDailyCap ?? 25,
    });
  } catch (err) {
    next(err);
  }
});


/* ---------------------------------------------------------- eval report */

/**
 * The published evaluation, readable without a user.
 *
 * The contract marks this route `auth: false` deliberately: a report nobody can
 * open without credentials is not published. It serves whatever the last eval
 * run wrote, and an empty report rather than a 404 when none has run, because
 * "no results yet" is a true answer and a 404 here reads as a broken route.
 */
contractRouter.get('/evals/report.json', async (req, res) => {
  try {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.join(config.root, 'reports', 'eval.json');
    res.set('cache-control', 'no-store').type('application/json').send(await readFile(file, 'utf8'));
  } catch {
    res.json({ generatedAt: null, cases: [], note: 'No evaluation has been run against this deployment yet.' });
  }
});
