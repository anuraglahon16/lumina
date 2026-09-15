import express from 'express';
import { z } from 'zod';
import { notFound, badRequest } from '../../shared/errors.js';
import { listThreads, getThread, deleteThread, createThread } from '../services/threads.js';

export const threadsRouter = express.Router();

threadsRouter.get('/threads', (req, res) => {
  res.json(listThreads(req.userId, { limit: Number(req.query.limit) || 50 }));
});

threadsRouter.post('/threads', (req, res, next) => {
  const parsed = z.object({ title: z.string().max(200).optional() }).safeParse(req.body || {});
  if (!parsed.success) return next(badRequest('Invalid thread', parsed.error.flatten()));
  res.status(201).json(createThread({ userId: req.userId, title: parsed.data.title }));
});

threadsRouter.get('/threads/:id', (req, res, next) => {
  const thread = getThread(req.params.id, req.userId);
  if (!thread) return next(notFound('Thread not found'));
  res.json(thread);
});

threadsRouter.delete('/threads/:id', (req, res, next) => {
  if (!deleteThread(req.params.id, req.userId)) return next(notFound('Thread not found'));
  res.status(204).end();
});
