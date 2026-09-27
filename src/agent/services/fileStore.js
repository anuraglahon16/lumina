import fs from 'node:fs/promises';
import path from 'node:path';
import { GridFSBucket } from 'mongodb';
import { config } from '../../shared/config.js';
import { mongoDb, mongoEnabled } from '../store/mongo.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('files');

/**
 * Where an uploaded file lives between the 202 and the worker reading it.
 *
 * It used to live in a module-scope Map, whose own error message said what that
 * meant: "upload buffer is gone (the service restarted before indexing ran)".
 * Anything that restarted in that window lost the bytes, and on a serverless
 * function that window was every invocation - which is why indexing had to
 * happen inside the request to work at all.
 *
 * GridFS when Mongo is configured, because the file may be larger than a
 * document and because the worker is a different process on a different
 * machine. A file under DATA_DIR otherwise, so local development and the test
 * suite keep working without a database.
 */

const bucketName = 'uploads';
const localDir = () => path.join(config.agent.dataDir, 'uploads');

export async function fileBackend() {
  return mongoEnabled() ? 'gridfs' : 'filesystem';
}

async function bucket() {
  return new GridFSBucket(await mongoDb(), { bucketName });
}

/** Store the bytes under the document's id. Overwrites a previous attempt. */
export async function putFile(docId, buffer, { filename, contentType } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('putFile needs a Buffer');
  if (mongoEnabled()) {
    const b = await bucket();
    // A retried upload for the same document must not leave two copies behind,
    // and `openUploadStream` does not replace.
    await deleteFile(docId);
    await new Promise((resolve, reject) => {
      const stream = b.openUploadStream(docId, { metadata: { doc_id: docId, filename, contentType } });
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(buffer);
    });
  } else {
    await fs.mkdir(localDir(), { recursive: true });
    await fs.writeFile(path.join(localDir(), `${docId}.bin`), buffer);
  }
  log.info('file_stored', { doc_id: docId, bytes: buffer.length, backend: await fileBackend() });
  return { docId, bytes: buffer.length };
}

/** The bytes, or null when nothing is stored for this document. */
export async function getFile(docId) {
  if (mongoEnabled()) {
    const b = await bucket();
    const files = await b.find({ filename: docId }).sort({ uploadDate: -1 }).limit(1).toArray();
    if (!files.length) return null;
    const chunks = [];
    for await (const chunk of b.openDownloadStream(files[0]._id)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  try {
    return await fs.readFile(path.join(localDir(), `${docId}.bin`));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** @returns {Promise<boolean>} whether anything was actually removed. */
export async function deleteFile(docId) {
  if (mongoEnabled()) {
    const b = await bucket();
    const files = await b.find({ filename: docId }).toArray();
    for (const f of files) await b.delete(f._id);
    return files.length > 0;
  }
  try {
    await fs.unlink(path.join(localDir(), `${docId}.bin`));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
