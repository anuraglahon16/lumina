import { jobQueue } from './jobs.js';
import { parseDocument as parseDocumentImpl } from './parsers.js';
import { chunkPages } from './chunker.js';
import { createDocument, updateDocument, indexChunks as indexChunksImpl, getDocument, searchChunks } from './ragStore.js';
import { putFile, getFile, deleteFile } from './fileStore.js';
import { newId } from '../../shared/ids.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('ingest');

/**
 * Accept an upload: store it, record it, queue it, answer.
 *
 * What this may do is the whole point. Authenticate and validate (the route),
 * put the bytes somewhere durable, create the document record, create a durable
 * job, return 202. Parsing, chunking, embedding, the vector write and the
 * read-after-write check belong to the worker and happen after the response.
 *
 * It used to hold the bytes in a module-scope Map and, on a platform that
 * freezes after responding, run the whole indexing pipeline inside the request -
 * so the 202 described work that had already finished, and any restart in
 * between lost the file.
 */
export async function enqueueDocument({ userId, filename, mimetype, buffer, spaceId = null, onAccepted, runInline = false }) {
  /**
   * Three sequential database trips, not four, and the order still guarantees
   * durability.
   *
   * Both ids are generated here, so the document can carry its `job_id` in the
   * insert instead of being updated afterwards. That update was a fourth round
   * trip inside a 300ms acceptance budget, on a cluster where opening a
   * connection costs 104-376ms - which is why two of eight deployed uploads took
   * 411ms and 478ms server-side against a median of 74.
   *
   * The order is unchanged and is the part that matters:
   *
   *   1. the bytes, so a worker on another machine can read them;
   *   2. the document, so there is something to show as `queued`;
   *   3. the job, LAST, because a claimable job whose file is not yet durable is
   *      a worker failing to find it.
   *
   * Nothing here is parallelised. Two of these writes are each other's
   * precondition, and saving a round trip by removing one is not the same as
   * saving it by removing the ordering.
   */
  const docId = newId('doc');
  const jobId = newId('job');
  await putFile(docId, buffer, { filename, contentType: mimetype });
  const doc = await createDocument({ userId, filename, mimetype, size: buffer.length, spaceId, docId, jobId });
  const job = await jobQueue.enqueue('index_document', { doc_id: docId }, { userId, maxAttempts: 2, id: jobId });

  /**
   * On a platform with no worker, the work happens before the response.
   *
   * It used to happen after: the route sent 202 and then awaited the job. That
   * looked equivalent and was not - a Vercel invocation ends when its response
   * is flushed, so the await never ran and documents sat at `queued` with zero
   * attempts forever. Verified in production, which is the only place the
   * behaviour exists.
   *
   * So on that platform the upload is slow and correct rather than fast and a
   * lie. Everywhere else the worker claims the job and this is skipped.
   */
  if (runInline) await jobQueue.runNow(job.id);

  // Only now, with the file stored and the job durable - and indexed too where
  // there is no worker to do it - is the upload accepted.
  onAccepted?.(doc);
  return { document: { ...(await getDocument(doc.id)) }, job: await jobQueue.get(job.id) };
}

/**
 * Index one document. This is the worker's body, exported so it can be driven
 * directly by a test and by the legacy inline path.
 *
 * `parseDocument`, `indexChunks` and `verify` are injectable for the same reason
 * the rest of this codebase injects its providers: the orchestration here - does
 * the status move in the right order, is the document verified before it is
 * called searchable - is what breaks, and none of it is about what a parser
 * actually returns.
 */
export async function indexDocumentJob(
  { doc_id: docId },
  { progress = async () => {}, parseDocument = parseDocumentImpl, indexChunks = indexChunksImpl, verify = null } = {},
) {
  const doc = await getDocument(docId);
  if (!doc) throw new Error(`document ${docId} no longer exists`);
  const buffer = await getFile(docId);
  if (!buffer) throw new Error(`no stored bytes for ${docId}`);

  try {
    await progress(0.05, 'parsing');
    await updateDocument(docId, { status: 'processing', stage: 'parsing', progress: 0.05 });
    const { pages, meta } = await parseDocument(buffer, { filename: doc.filename, mimetype: doc.mimetype });
    if (!pages.length) throw new Error('no extractable text in this file');

    await progress(0.25, 'chunking');
    await updateDocument(docId, { stage: 'chunking', progress: 0.25, page_count: meta.page_count });
    const chunks = chunkPages(pages);
    if (!chunks.length) throw new Error('document produced no usable chunks');

    await progress(0.35, 'embedding');
    await updateDocument(docId, { stage: 'embedding', progress: 0.35, chunk_count: chunks.length });
    /**
     * Progress is written at most once a second, and the writes do not block
     * each other.
     *
     * Every embedding batch wrote twice - the job row and the document row - on
     * the same shared cluster that is accepting uploads. Measured: with the
     * worker stopped, acceptance p95 over twenty uploads is 245ms; with it
     * indexing those same twenty documents, 626ms. The contention is real and
     * these writes are the part of it that scales with document size, while
     * being the least load-bearing thing the worker does - nobody needs a
     * progress bar at 0.412 rather than 0.455.
     *
     * Stage transitions above are not throttled: those say what is happening,
     * not how far along it is.
     */
    let lastProgressAt = 0;
    const { provider } = await indexChunks(doc, chunks, {
      onProgress: async (fraction) => {
        const now = Date.now();
        if (now - lastProgressAt < 1000) return;
        lastProgressAt = now;
        const p = 0.35 + fraction * 0.55;
        // Two collections, neither waiting on the other.
        await Promise.all([progress(p, 'embedding'), updateDocument(docId, { progress: Number(p.toFixed(3)) })]);
      },
    });

    /**
     * Read it back before calling it searchable.
     *
     * A document reached 95% "embedding" on the deployment and stopped there
     * with no error recorded: the write looked like it had succeeded and
     * nothing ever checked. `indexed` is a promise to the reader that a
     * question can find this file, so it is only made after a query does.
     */
    await progress(0.95, 'verifying');
    await updateDocument(docId, { stage: 'verifying', progress: 0.95 });
    const probe = chunks[0].text.split(/\s+/).slice(0, 8).join(' ');
    const found = verify
      ? await verify(probe, doc)
      : (await searchChunks(probe, { userId: doc.user_id, docIds: [docId], spaceId: doc.space_id ?? null })).results.length;
    if (!found) throw new Error(`verification found no retrievable chunk for ${docId} after indexing`);

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
    log.info('document_indexed', { doc_id: docId, chunks: chunks.length, pages: meta.page_count, provider, verified: found });
    // The original upload is no longer needed once its chunks are searchable.
    await deleteFile(docId).catch(() => {});
    return { doc_id: docId, chunks: chunks.length, pages: meta.page_count, embedding_provider: provider };
  } catch (err) {
    await updateDocument(docId, { status: 'failed', stage: 'failed', error: err.message });
    throw err;
  }
}

jobQueue.register('index_document', async (payload, ctx) => indexDocumentJob(payload, { progress: ctx.progress }));
