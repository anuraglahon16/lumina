import express from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../shared/errors.js';
import { listMemories, deleteMemory, clearMemories, saveMemory, searchMemories, MEMORY_KINDS } from '../services/memoryStore.js';

export const memoriesRouter = express.Router();

/** Memories are the user's data: fully visible, individually deletable. */
memoriesRouter.get('/memories', async (req, res) => {
  if (req.query.q) {
    return res.json({ items: await searchMemories(String(req.query.q), { userId: req.userId, topK: 20 }) });
  }
  res.json(await listMemories(req.userId, { limit: Number(req.query.limit) || 200 }));
});

memoriesRouter.post('/memories', async (req, res, next) => {
  const parsed = z
    .object({ content: z.string().trim().min(3).max(500), kind: z.enum(MEMORY_KINDS).optional() })
    .safeParse(req.body);
  if (!parsed.success) return next(badRequest('Invalid memory', parsed.error.flatten()));
  const saved = await saveMemory({ userId: req.userId, ...parsed.data, source: 'user', confidence: 1 });
  res.status(201).json(saved);
});

memoriesRouter.delete('/memories/:id', async (req, res, next) => {
  if (!(await deleteMemory(req.params.id, req.userId))) return next(notFound('Memory not found'));
  res.status(204).end();
});

memoriesRouter.delete('/memories', async (req, res) => {
  res.json({ deleted: await clearMemories(req.userId) });
});
