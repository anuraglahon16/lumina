import { jobQueue } from './jobs.js';
import { parseDocument } from './parsers.js';
import { chunkPages } from './chunker.js';
import { createDocument, updateDocument, indexChunks, getDocument } from './ragStore.js';
import { createLogger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';

const log = createLogger('ingest');

// Buffers live in memory between enqueue and execution. The queue is
// in-process, so there is no need to spill them to disk first.
const pendingUploads = new Map();

/**
 * Accept an upload and return immediately. Parsing, chunking, embedding, and
 * indexing all happen in the background job below; the client polls the
 * document (or the job) for progress.
 */
export async function enqueueDocument({ userId, filename, mimetype, buffer }) {
  const doc = await createDocument({ userId, filename, mimetype, size: buffer.length });
  pendingUploads.set(doc.id, buffer);
  const job = await jobQueue.enqueue('index_document', { doc_id: doc.id }, { userId, maxAttempts: 2 });
  await updateDocument(doc.id, { job_id: job.id });

  // On a platform that freezes the process once a response is sent, returning
  // 202 and indexing afterwards means never indexing at all: the upload would
  // sit at "queued" forever and the document would never become searchable.
  // Waiting costs the user the indexing time on upload, which is the honest
  // trade and the only one available.
  if (config.runtime.serverless) await jobQueue.drain(job.id);

  return { document: { ...(await getDocument(doc.id)) }, job: await jobQueue.get(job.id) };
}

jobQueue.register('index_document', async ({ doc_id: docId }, ctx) => {
  const doc = await getDocument(docId);
  if (!doc) throw new Error(`document ${docId} no longer exists`);
  const buffer = pendingUploads.get(docId);
  if (!buffer) throw new Error('upload buffer is gone (the service restarted before indexing ran)');

  try {
    ctx.progress(0.05, 'parsing');
    await updateDocument(docId, { status: 'processing', stage: 'parsing', progress: 0.05 });
    const { pages, meta } = await parseDocument(buffer, { filename: doc.filename, mimetype: doc.mimetype });
    if (!pages.length) throw new Error('no extractable text in this file');

    ctx.progress(0.25, 'chunking');
    await updateDocument(docId, { stage: 'chunking', progress: 0.25, page_count: meta.page_count });
    const chunks = chunkPages(pages);
    if (!chunks.length) throw new Error('document produced no usable chunks');

    ctx.progress(0.35, 'embedding');
    await updateDocument(docId, { stage: 'embedding', progress: 0.35, chunk_count: chunks.length });
    const { provider } = await indexChunks(doc, chunks, {
      onProgress: async (fraction) => {
        const progress = 0.35 + fraction * 0.6;
        await ctx.progress(progress, 'embedding');
        await updateDocument(docId, { progress: Number(progress.toFixed(3)) });
      },
    });

    await updateDocument(docId, {
      status: 'indexed',
      stage: 'indexed',
      progress: 1,
      chunk_count: chunks.length,
      page_count: meta.page_count,
      embedding_provider: provider,
      indexed_at: new Date().toISOString(),
      error: null,
    });
    log.info('document_indexed', { doc_id: docId, chunks: chunks.length, pages: meta.page_count, provider });
    return { doc_id: docId, chunks: chunks.length, pages: meta.page_count, embedding_provider: provider };
  } catch (err) {
    await updateDocument(docId, { status: 'failed', stage: 'failed', error: err.message });
    throw err;
  } finally {
    pendingUploads.delete(docId);
  }
});
