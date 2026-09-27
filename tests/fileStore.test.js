import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An uploaded file has to outlive the request that carried it.
 *
 * It did not. The bytes lived in a module-scope Map:
 *
 *   const buffer = pendingUploads.get(docId);
 *   if (!buffer) throw new Error('upload buffer is gone (the service restarted before indexing ran)');
 *
 * The error message is the design admitting it. Any restart between the 202 and
 * the indexing lost the file, and the document sat in the database describing a
 * file nobody could read. On the deployed function that window was every
 * invocation, which is why indexing had to run inside the request to work at
 * all - the thing the architecture says it must not do.
 *
 * So the bytes go somewhere durable before the 202, and the worker reads them
 * back from there. GridFS when Mongo is configured, a file under DATA_DIR
 * otherwise, because the local JSON store has no GridFS to offer.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-filestore-'));
process.env.MONGODB_URI = '';

const { putFile, getFile, deleteFile, fileBackend } = await import('../src/agent/services/fileStore.js');

const bytes = Buffer.from('%PDF-1.4 a small pretend document with \x00 binary \xff bytes');

test('a stored file comes back byte for byte', async () => {
  await putFile('doc_a', bytes, { filename: 'a.pdf', contentType: 'application/pdf' });
  const back = await getFile('doc_a');
  assert.ok(Buffer.isBuffer(back), 'a Buffer, not a string');
  assert.equal(back.length, bytes.length);
  assert.ok(back.equals(bytes), 'binary survived the round trip');
});

test('the bytes survive a process that forgot everything', async () => {
  // The point of the whole change: a fresh import, as a restarted worker would
  // have, still finds the file.
  await putFile('doc_restart', bytes, { filename: 'r.pdf', contentType: 'application/pdf' });
  const fresh = await import(`../src/agent/services/fileStore.js?restart=${Date.now()}`);
  const back = await fresh.getFile('doc_restart');
  assert.ok(back.equals(bytes), 'a new module instance can still read it');
});

test('a missing file is null rather than a throw', async () => {
  assert.equal(await getFile('doc_never_existed'), null);
});

test('deleting is idempotent', async () => {
  await putFile('doc_del', bytes, { filename: 'd.pdf', contentType: 'application/pdf' });
  assert.equal(await deleteFile('doc_del'), true);
  assert.equal(await getFile('doc_del'), null);
  assert.equal(await deleteFile('doc_del'), false, 'deleting twice is not an error');
});

test('the backend says which one it is', async () => {
  // Reported so a deployment cannot quietly be using the local fallback while
  // its health check claims MongoDB.
  assert.equal(await fileBackend(), 'filesystem', 'no MONGODB_URI here');
});

test('a large file is not truncated', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  await putFile('doc_big', big, { filename: 'big.pdf', contentType: 'application/pdf' });
  const back = await getFile('doc_big');
  assert.equal(back.length, big.length, '3MB round trip');
  assert.ok(back.equals(big));
});
