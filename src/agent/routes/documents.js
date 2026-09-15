import express from 'express';
import multer from 'multer';
import { config } from '../../shared/config.js';
import { badRequest, notFound, HttpError } from '../../shared/errors.js';
import { enqueueDocument } from '../services/ingest.js';
import { listDocuments, getDocument, deleteDocument, documentStats, searchChunks } from '../services/ragStore.js';
import { detectKind } from '../services/parsers.js';
import { jobQueue } from '../services/jobs.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.gateway.maxUploadBytes, files: 5 },
});

export const documentsRouter = express.Router();

/**
 * POST /v1/documents. Accepts files and returns 202 immediately.
 * Parsing/chunking/embedding/indexing run as background jobs.
 */
/** Translate multer's own failures into the API's error shape. */
const handleUpload = (req, res, next) =>
  upload.array('files', 5)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, 'file_too_large', `Each file must be under ${Math.round(config.gateway.maxUploadBytes / 1024 / 1024)}MB`));
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(badRequest('Too many files, or an unexpected multipart field (expected "files")'));
    }
    return next(badRequest(`Upload rejected: ${err.message}`));
  });

documentsRouter.post('/documents', handleUpload, (req, res, next) => {
  const files = req.files || [];
  if (!files.length) return next(badRequest('No files uploaded (expected multipart field "files")'));

  const accepted = [];
  const rejected = [];
  for (const file of files) {
    if (!detectKind(file.originalname, file.mimetype)) {
      rejected.push({ filename: file.originalname, reason: `unsupported type: ${file.mimetype || 'unknown'}` });
      continue;
    }
    const { document, job } = enqueueDocument({
      userId: req.userId,
      filename: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
    });
    accepted.push({
      id: document.id,
      filename: document.filename,
      size_bytes: document.size_bytes,
      status: document.status,
      job_id: job.id,
      status_url: `/v1/documents/${document.id}`,
    });
  }

  res.status(202).json({ accepted, rejected });
});

documentsRouter.get('/documents', (req, res) => {
  const { total, items } = listDocuments(req.userId);
  res.json({ total, stats: documentStats(req.userId), items: items.map(publicDoc) });
});

documentsRouter.get('/documents/:id', (req, res, next) => {
  const doc = getDocument(req.params.id);
  if (!doc || doc.user_id !== req.userId) return next(notFound('Document not found'));
  const job = doc.job_id ? jobQueue.get(doc.job_id) : null;
  res.json({ ...publicDoc(doc), job: job && { id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error } });
});

documentsRouter.delete('/documents/:id', (req, res, next) => {
  if (!deleteDocument(req.params.id, req.userId)) return next(notFound('Document not found'));
  res.status(204).end();
});

/** Direct RAG probe, useful for debugging retrieval without running an agent. */
documentsRouter.get('/documents/search/query', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (!q) return next(badRequest('Missing ?q='));
  res.json(await searchChunks(q, { userId: req.userId, topK: Number(req.query.k) || 6 }));
});

function publicDoc(d) {
  return {
    id: d.id,
    filename: d.filename,
    mimetype: d.mimetype,
    size_bytes: d.size_bytes,
    status: d.status,
    stage: d.stage,
    progress: d.progress,
    page_count: d.page_count,
    chunk_count: d.chunk_count,
    embedding_provider: d.embedding_provider,
    error: d.error,
    job_id: d.job_id,
    created_at: d.created_at,
    indexed_at: d.indexed_at,
  };
}
