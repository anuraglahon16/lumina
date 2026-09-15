import express from 'express';
import { z } from 'zod';
import { notFound, badRequest } from '../../shared/errors.js';
import { listThreads, getThread, deleteThread, createThread } from '../services/threads.js';

export const threadsRouter = express.Router();

threadsRouter.get('/threads', async (req, res) => {
  res.json(await listThreads(req.userId, { limit: Number(req.query.limit) || 50 }));
});

threadsRouter.post('/threads', async (req, res, next) => {
  const parsed = z.object({ title: z.string().max(200).optional() }).safeParse(req.body || {});
  if (!parsed.success) return next(badRequest('Invalid thread', parsed.error.flatten()));
  res.status(201).json(await createThread({ userId: req.userId, title: parsed.data.title }));
});

threadsRouter.get('/threads/:id', async (req, res, next) => {
  const thread = await getThread(req.params.id, req.userId);
  if (!thread) return next(notFound('Thread not found'));
  res.json(thread);
});

threadsRouter.delete('/threads/:id', async (req, res, next) => {
  if (!(await deleteThread(req.params.id, req.userId))) return next(notFound('Thread not found'));
  res.status(204).end();
});
