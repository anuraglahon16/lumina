import express from 'express';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { forwardJson, forwardSse, forwardUpload } from './proxy.js';

export const apiRouter = express.Router();

const querySchema = z.object({
  query: z.string().trim().min(3, 'Ask a question of at least 3 characters').max(2000),
  mode: z.enum(['quick', 'deep']).default('quick'),
  thread_id: z.string().max(64).optional(),
  async: z.boolean().optional(),
});

/**
 * POST /api/query, the one expensive endpoint. Validated here so a malformed
 * request never reaches the agent, and rate limited by mode because Deep Search
 * costs orders of magnitude more than Quick.
 */
apiRouter.post(
  '/query',
  (req, res, next) => {
    const parsed = querySchema.safeParse(req.body);
    if (!parsed.success) return next(badRequest('Invalid query request', parsed.error.flatten()));
    req.body = parsed.data;
    next();
  },
  (req, res, next) => rateLimit(req.body.mode === 'deep' ? 'deep' : 'quick')(req, res, next),
  (req, res, next) => {
    if (req.body.async) return forwardJson(req, res, next, { path: '/v1/query' });
    return forwardSse(req, res, next, { path: '/v1/query' });
  },
);

apiRouter.get('/runs/stream/:streamId', (req, res, next) =>
  forwardSse(req, res, next, { path: `/v1/runs/stream/${encodeURIComponent(req.params.streamId)}`, method: 'GET' }),
);

apiRouter.post('/documents', rateLimit('upload'), forwardUpload);

// Everything else is a cheap read/write: validate shape, forward, relay.
const passthrough = [
  ['get', '/threads'],
  ['post', '/threads'],
  ['get', '/threads/:id'],
  ['delete', '/threads/:id'],
  ['get', '/memories'],
  ['post', '/memories'],
  ['delete', '/memories/:id'],
  ['delete', '/memories'],
  ['get', '/documents'],
  ['get', '/documents/:id'],
  ['delete', '/documents/:id'],
  ['get', '/documents/search/query'],
  ['get', '/runs'],
  ['get', '/runs/stats'],
  ['get', '/runs/:id'],
  ['get', '/jobs'],
  ['get', '/jobs/:id'],
  ['get', '/capabilities'],
];

for (const [method, path] of passthrough) {
  apiRouter[method](path, rateLimit('global'), (req, res, next) => forwardJson(req, res, next));
}
