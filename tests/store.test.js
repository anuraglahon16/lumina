import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection } from '../src/agent/store/jsonStore.js';

/**
 * The store contract, asserted against the JSON backend.
 *
 * Callers are written against one interface and never branch on which backend
 * they have, so any behaviour that differs between the two is a bug that only
 * appears in whichever environment is configured differently from the one the
 * code was written in. These tests describe what both must do; the Mongo
 * backend is exercised by the smoke suite, which runs against a real cluster.
 */

const fresh = (name = 'test') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-store-'));
  return new Collection(name, { dir });
};

test('put returns the stored item and stamps timestamps', async () => {
  const c = fresh();
  const item = await c.put({ id: 'a', n: 1 });
  assert.equal(item.id, 'a');
  assert.ok(item.created_at, 'created_at is set on first write');
  assert.ok(item.updated_at);
});

test('put preserves created_at across updates, so age is not reset by an edit', async () => {
  const c = fresh();
  const first = await c.put({ id: 'a', n: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const second = await c.put({ id: 'a', n: 2 });
  assert.equal(second.created_at, first.created_at);
  assert.equal(second.n, 2);
  assert.notEqual(second.updated_at, first.updated_at);
});

test('patch merges into the existing item and returns null for a missing one', async () => {
  const c = fresh();
  await c.put({ id: 'a', n: 1, keep: 'yes' });
  const patched = await c.patch('a', { n: 2 });
  assert.equal(patched.n, 2);
  assert.equal(patched.keep, 'yes', 'fields not named by the patch survive');
  assert.equal(await c.patch('missing', { n: 1 }), null);
});

test('get returns null rather than undefined for a missing id', async () => {
  const c = fresh();
  assert.equal(await c.get('nope'), null);
});

test('delete reports whether anything was removed', async () => {
  const c = fresh();
  await c.put({ id: 'a' });
  assert.equal(await c.delete('a'), true);
  assert.equal(await c.delete('a'), false, 'deleting twice is not an error, but it is not a deletion either');
});

test('list filters, counts the full match, and pages the slice', async () => {
  const c = fresh();
  for (let i = 0; i < 5; i += 1) await c.put({ id: `u1-${i}`, user_id: 'u1', created_at: `2026-01-0${i + 1}` });
  await c.put({ id: 'other', user_id: 'u2' });

  const page = await c.list({ user_id: 'u1' }, { limit: 2 });
  assert.equal(page.total, 5, 'total is the size of the match, not of the page');
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((i) => i.user_id === 'u1'), 'another user never appears');
});

test('list sorts newest first by default, which is what every listing shows', async () => {
  const c = fresh();
  await c.put({ id: 'old', created_at: '2026-01-01' });
  await c.put({ id: 'new', created_at: '2026-06-01' });
  const { items } = await c.list({});
  assert.equal(items[0].id, 'new');

  const asc = await c.list({}, { desc: false });
  assert.equal(asc.items[0].id, 'old');
});

test('list can sort on another key, as thread listings do on last activity', async () => {
  const c = fresh();
  await c.put({ id: 'a', created_at: '2026-01-01', last_activity_at: '2026-09-01' });
  await c.put({ id: 'b', created_at: '2026-06-01', last_activity_at: '2026-02-01' });
  const { items } = await c.list({}, { sortKey: 'last_activity_at' });
  assert.equal(items[0].id, 'a');
});

test('count respects the filter', async () => {
  const c = fresh();
  await c.put({ id: '1', user_id: 'u1' });
  await c.put({ id: '2', user_id: 'u1' });
  await c.put({ id: '3', user_id: 'u2' });
  assert.equal(await c.count({ user_id: 'u1' }), 2);
  assert.equal(await c.count({}), 3);
});

test('all returns every match unpaged, for callers that must scan a corpus', async () => {
  const c = fresh();
  for (let i = 0; i < 150; i += 1) await c.put({ id: `c${i}`, user_id: 'u1' });
  const everything = await c.all({ user_id: 'u1' });
  assert.equal(everything.length, 150, 'BM25 over a corpus cannot be limited to a page');

  const listed = await c.list({ user_id: 'u1' });
  assert.equal(listed.items.length, 100, 'list still caps, so a big store cannot blow a response');
});

test('data survives a reload, which is the only reason to persist at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-store-'));
  const first = new Collection('threads', { dir });
  await first.put({ id: 'a', user_id: 'u1', title: 'kept' });
  await first.flush();

  const reopened = new Collection('threads', { dir });
  const found = await reopened.get('a');
  assert.equal(found?.title, 'kept');
});

test('a corrupt file is quarantined rather than taking the service down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-store-'));
  fs.writeFileSync(path.join(dir, 'runs.json'), '{ not json at all');
  const c = new Collection('runs', { dir });
  assert.equal(await c.count({}), 0, 'it starts empty instead of throwing at boot');
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('corrupt'));
  assert.equal(quarantined.length, 1, 'the unreadable file is kept, not silently discarded');
});
