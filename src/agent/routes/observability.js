import express from 'express';
import { config, capabilities } from '../../shared/config.js';
import { notFound } from '../../shared/errors.js';
import { getRun, listRuns, runStats } from '../store/runLog.js';
import { jobQueue } from '../services/jobs.js';
import { cache } from '../services/cache.js';
import { searchHealth, resolveProviders } from '../services/search/index.js';
import { resolveEmbeddingProvider } from '../services/embeddings.js';
import { breakerReport } from '../../shared/circuitBreaker.js';
import { vectorBackend } from '../services/vectorStore.js';
import { pingMongo, mongoEnabled } from '../store/mongo.js';

export const observabilityRouter = express.Router();

observabilityRouter.get('/health', async (req, res) => {
  const caps = capabilities();
  res.json({
    status: caps.llm ? 'ok' : 'degraded',
    service: 'agent',
    checks: {
      llm: caps.llm ? 'configured' : 'missing ANTHROPIC_API_KEY',
      search_provider: resolveProviders()[0],
      search_degraded: resolveProviders()[0] === 'duckduckgo',
      // What search last did, not merely which key exists. A rejected key is
      // otherwise indistinguishable from a working one until answers arrive
      // with no sources.
      search_last: searchHealth(),
      embedding_provider: resolveEmbeddingProvider(),
      // Where chunks live and how vectors are searched. "mongo-cosine-scan"
      // means a real database but no Atlas index, which is a working setup that
      // should never be mistaken for the indexed one.
      store: mongoEnabled() ? 'mongodb' : 'json',
      vector_backend: vectorBackend(),
      mongo: await pingMongo(),
      // A tripped breaker is why calls are failing fast, so health says so
      // rather than leaving it to be inferred from errors.
      circuits: breakerReport(),
    },
    model: config.llm.model,
    uptime_s: Math.round(process.uptime()),
  });
});

observabilityRouter.get('/capabilities', (req, res) => {
  res.json({
    capabilities: capabilities(),
    active: {
      search: resolveProviders()[0],
      embeddings: resolveEmbeddingProvider(),
      model: config.llm.model,
      // The routing table is part of what a run cost, so it is reported rather
      // than left implicit in the environment.
      models: {
        answer: config.llm.model,
        deep_branch: config.llm.branchModel,
        mechanical: config.llm.fastModel,
      },
    },
    budgets: config.budgets,
    cache: cache.summary(),
  });
});

/** Run logs: everything the harness measured, per run. */
observabilityRouter.get('/runs', (req, res) => {
  res.json(
    listRuns(
      { userId: req.userId, mode: req.query.mode, threadId: req.query.thread_id },
      { limit: Number(req.query.limit) || 50 },
    ),
  );
});

observabilityRouter.get('/runs/stats', (req, res) => {
  const allUsers = req.query.all === 'true';
  const stats = runStats({ userId: allUsers ? undefined : req.userId, mode: req.query.mode });
  // Stats are per-user, and an API client without the cookie is a fresh user
  // every call, so an empty result looks like "nothing was ever run". Say which
  // scope produced it instead of returning a bare zero.
  res.json({ ...stats, scope: allUsers ? 'all_users' : 'current_user', ...(stats.runs === 0 && !allUsers ? { hint: 'No runs for this user. Use ?all=true for every user.' } : {}) });
});

observabilityRouter.get('/runs/:id', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run || run.user_id !== req.userId) return next(notFound('Run not found'));
  res.json(run);
});

observabilityRouter.get('/jobs', (req, res) => {
  res.json(jobQueue.list({ userId: req.userId, type: req.query.type }, { limit: Number(req.query.limit) || 50 }));
});

observabilityRouter.get('/jobs/:id', (req, res, next) => {
  const job = jobQueue.get(req.params.id);
  if (!job || (job.user_id && job.user_id !== req.userId)) return next(notFound('Job not found'));
  res.json(job);
});
