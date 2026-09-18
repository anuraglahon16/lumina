import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A filesystem that refuses to be written to must not take the service down.
 *
 * `runLog.js` says exactly that — "A filesystem that refuses to be written to
 * therefore costs the convenience, not the run, which matters on a serverless
 * bundle where everything outside /tmp is read-only" — and then defeats it by
 * calling `collection('runs')` at module scope. The Collection constructor
 * mkdirs eagerly, so on Vercel without MONGODB_URI the import threw
 * `ENOENT: mkdir '/var/task/data'` and the function died before any route ran.
 * Every preview route answered FUNCTION_INVOCATION_FAILED; the deployment was
 * READY and completely unreachable.
 *
 * The directory here is unwritable the way a bundle is: a path underneath a
 * regular file, so mkdir fails with ENOTDIR without needing a root-owned mount.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-readonly-'));
const blocker = path.join(tmp, 'not-a-directory');
fs.writeFileSync(blocker, 'a file where a directory would have to go');
const unwritable = path.join(blocker, 'data');

process.env.DATA_DIR = unwritable;
process.env.MONGODB_URI = '';

const { Collection, collection, flushAll } = await import('../src/agent/store/jsonStore.js');

test('mkdir really does fail on this path', () => {
  // Otherwise the rest of the file proves nothing.
  assert.throws(() => fs.mkdirSync(unwritable, { recursive: true }), (err) => ['ENOTDIR', 'EEXIST', 'EACCES'].includes(err.code));
});

test('a collection on an unwritable directory constructs instead of throwing', () => {
  const c = new Collection('runs', { dir: unwritable });
  assert.ok(c, 'construction survived');
});

test('it still stores and reads within the process', async () => {
  const c = new Collection('threads', { dir: unwritable });
  await c.put({ id: 't1', title: 'kept in memory' });
  assert.equal((await c.get('t1')).title, 'kept in memory');
  const { items } = await c.list({});
  assert.equal(items.length, 1, 'the row is queryable');
});

test('flushing is a no-op rather than a rejection', async () => {
  const c = new Collection('memories', { dir: unwritable });
  await c.put({ id: 'm1', text: 'remember me' });
  await c.flush();
  await flushAll();
});

test('importing the run log does not throw', async () => {
  // The actual crash: this module builds its collection at import time, so a
  // failure here is not a failed write but a dead function.
  const runLog = await import('../src/agent/store/runLog.js');
  assert.ok(runLog, 'the module loaded');
});

test('a writable directory still persists to disk', async () => {
  // The degrade must not become the behaviour everywhere.
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-writable-'));
  const c = new Collection('spaces', { dir: good });
  await c.put({ id: 's1', name: 'written down' });
  await c.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(good, 'spaces.json'), 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].name, 'written down');
});

test('the registry hands back the same degraded collection twice', () => {
  assert.equal(collection('runs'), collection('runs'), 'still a singleton per process');
});
