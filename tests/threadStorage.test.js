import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A thread is a header; its messages are their own documents.
 *
 * They used to be a `messages` array on the thread, which made every append a
 * read-modify-write: read the thread, concatenate, write the whole document
 * back. Two appends landing together both read the same array and the second
 * overwrote the first, so a turn could disappear - and appending cost grew with
 * the conversation, because the entire history was rewritten each time.
 * `scripts/indexes.json` declares `messages: { threadId: 1, createdAt: 1 }`,
 * an index over a collection that did not exist.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-threads-'));
process.env.MONGODB_URI = '';

const { createThread, appendMessage, getThread, threadContext, threadMessages, listThreads, deleteThread } =
  await import('../src/agent/services/threads.js');
const { collection } = await import('../src/agent/store/jsonStore.js');
const { ThreadDoc, MessageDoc } = await import('../packages/contract/dist/db.js');

test('a thread header holds no messages array', async () => {
  const t = await createThread({ userId: 'u1', title: null });
  const header = await getThread(t.id, 'u1');
  assert.ok(!('messages' in header), 'the transcript is not embedded in the header');
  assert.equal(header.messageCount, 0, 'and the count starts at zero');
});

test('the header validates as a ThreadDoc and a message as a MessageDoc', async () => {
  const t = await createThread({ userId: 'u_contract', title: 'Shapes' });
  // Both contract schemas are non-strict objects, so the snake_case fields every
  // reader uses are carried alongside without breaking validation.
  const header = await getThread(t.id, 'u_contract');
  assert.doesNotThrow(() => ThreadDoc.parse(header), 'ThreadDoc');

  await appendMessage(t.id, { role: 'user', content: 'a question' });
  const [m] = await threadMessages(t.id);
  assert.doesNotThrow(() => MessageDoc.parse(m), `MessageDoc: ${JSON.stringify(Object.keys(m))}`);
  assert.equal(m._id, m.id, 'the contract _id is the message id, not a surrogate');
  assert.equal(m.threadId, t.id);
  assert.equal(m.userId, 'u_contract');
  assert.ok(Array.isArray(m.sources), 'sources defaults to an array rather than being absent');
});

test('two appends landing together both survive', async () => {
  // The defect the split exists for. Under the old shape both reads saw the same
  // array and the second write erased the first.
  const t = await createThread({ userId: 'u2', title: 'Race' });
  await Promise.all([
    appendMessage(t.id, { role: 'user', content: 'first' }),
    appendMessage(t.id, { role: 'user', content: 'second' }),
  ]);
  const rows = await threadMessages(t.id);
  assert.equal(rows.length, 2, `both appends persisted, got ${rows.map((r) => r.content).join(',')}`);
  assert.deepEqual(new Set(rows.map((r) => r.content)), new Set(['first', 'second']));
});

test('the message count is incremented, never recomputed from a read', async () => {
  const t = await createThread({ userId: 'u3', title: 'Counting' });
  for (let i = 0; i < 12; i += 1) await appendMessage(t.id, { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });

  const header = await getThread(t.id, 'u3');
  const rows = await threadMessages(t.id);
  assert.equal(header.messageCount, 12, 'the header count');
  assert.equal(rows.length, 12, 'and the collection agree');

  const listed = await listThreads('u3');
  assert.equal(listed.items.find((x) => x.id === t.id)?.message_count, 12, 'and so does the list endpoint');
});

test('appending does not read the thread document to build the new one', () => {
  const src = fs.readFileSync(new URL('../src/agent/services/threads.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function appendMessage'), src.indexOf('export async function threadContext'));
  assert.match(fn, /messages\.insert\(/, 'the message is inserted');
  assert.match(fn, /threads\.bump\(threadId, \{ set, inc: \{ messageCount: 1 \} \}\)/, 'and the header is set-and-incremented');
  assert.ok(!/threads\.put\(/.test(fn), 'the whole thread is never rewritten');
  assert.ok(!/\.\.\.thread\.messages/.test(fn), 'and no array is concatenated');
});

test('the context window is asked of the store, not sliced from everything', async () => {
  const t = await createThread({ userId: 'u4', title: 'Window' });
  for (let i = 0; i < 20; i += 1) {
    await appendMessage(t.id, { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });
  }
  const ctx = await threadContext(t.id, { window: 4 });
  assert.equal(ctx.length, 4, 'the window is the window');
  // Oldest first within the window: the model reads a conversation forwards.
  assert.deepEqual(ctx.map((m) => m.content), ['turn 16', 'turn 17', 'turn 18', 'turn 19']);

  const src = fs.readFileSync(new URL('../src/agent/services/threads.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function threadContext'), src.indexOf('export async function threadMessages'));
  assert.match(fn, /sortKey: 'seq', desc: true, limit:/, 'the store returns the last N by position');
  assert.match(fn, /\.reverse\(\)/, 'which are then put back in reading order');
});

test('a tool or system turn never reaches the model as context', async () => {
  const t = await createThread({ userId: 'u5', title: 'Roles' });
  await appendMessage(t.id, { role: 'user', content: 'ask' });
  await appendMessage(t.id, { role: 'system', content: 'bookkeeping' });
  await appendMessage(t.id, { role: 'assistant', content: 'answer' });
  const ctx = await threadContext(t.id, { window: 8 });
  assert.deepEqual(ctx.map((m) => m.role), ['user', 'assistant']);
});

test('the first user turn names the thread, and later ones do not rename it', async () => {
  const t = await createThread({ userId: 'u6', title: null });
  assert.equal(t.title, 'New thread');
  await appendMessage(t.id, { role: 'user', content: 'How does rank fusion work?' });
  assert.equal((await getThread(t.id, 'u6')).title, 'How does rank fusion work?');
  await appendMessage(t.id, { role: 'user', content: 'And what about reranking?' });
  assert.equal((await getThread(t.id, 'u6')).title, 'How does rank fusion work?', 'the title is set once');
});

test('deleting a thread deletes its messages', async () => {
  // They are separate documents now, so the header going away does not take them
  // with it - they would stay, invisible and still indexed.
  const t = await createThread({ userId: 'u7', title: 'Doomed' });
  for (let i = 0; i < 5; i += 1) await appendMessage(t.id, { role: 'user', content: `x${i}` });
  assert.equal((await collection('messages').list({ thread_id: t.id }, { limit: 100 })).items.length, 5);

  assert.equal(await deleteThread(t.id, 'u7'), true);
  assert.equal(await getThread(t.id, 'u7'), null, 'the header is gone');
  assert.equal(
    (await collection('messages').list({ thread_id: t.id }, { limit: 100 })).items.length,
    0,
    'and so are its messages',
  );
});

test('an answer turn keeps its answerId and its sources', async () => {
  const t = await createThread({ userId: 'u8', title: 'Answer' });
  await appendMessage(t.id, {
    role: 'assistant',
    content: 'The answer [1].',
    run_id: 'run_abc',
    mode: 'deep',
    sources: [{ n: 1, title: 'A page', url: 'https://example.test/a', type: 'web' }],
  });
  const [m] = await threadMessages(t.id);
  assert.equal(m.answerId, 'run_abc', 'the contract spelling');
  assert.equal(m.run_id, 'run_abc', 'and the one existing readers use');
  assert.equal(m.sources.length, 1);
  assert.equal(m.mode, 'deep', 'and anything else the caller passed');
});

test('turns in the same millisecond still order correctly', async () => {
  // The defect `seq` exists for: these all share a createdAt, so a time sort has
  // nothing to separate them by and returned the window backwards.
  const t = await createThread({ userId: 'u_tie', title: 'Ties' });
  await Promise.all(Array.from({ length: 6 }, (_, i) => appendMessage(t.id, { role: 'user', content: `turn ${i}` })));
  const rows = await threadMessages(t.id);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6], 'every turn has a distinct position');
  const stamps = new Set(rows.map((r) => r.createdAt));
  if (stamps.size < rows.length) {
    // Which is the point: the timestamps tie and the order is still total.
    assert.equal(new Set(rows.map((r) => r.seq)).size, 6, 'positions do not tie even when timestamps do');
  }
});

test('a message carries createdAt, which the old shape never set', async () => {
  // The route read `m.created_at` while the append wrote `at`, so `createdAt`
  // was absent from every message this endpoint has ever returned.
  const t = await createThread({ userId: 'u9', title: 'Time' });
  await appendMessage(t.id, { role: 'user', content: 'when?' });
  const [m] = await threadMessages(t.id);
  assert.ok(m.createdAt, 'the contract field is set');
  assert.ok(!Number.isNaN(Date.parse(m.createdAt)), 'and is a date');

  const route = fs.readFileSync(new URL('../src/agent/routes/contract.js', import.meta.url), 'utf8');
  assert.match(route, /m\.createdAt \?\? m\.created_at \?\? m\.at/, 'the route reads it, with the old spellings as fallbacks');
});

test('messages are scoped to their thread', async () => {
  const a = await createThread({ userId: 'u10', title: 'A' });
  const b = await createThread({ userId: 'u10', title: 'B' });
  await appendMessage(a.id, { role: 'user', content: 'in A' });
  await appendMessage(b.id, { role: 'user', content: 'in B' });
  assert.deepEqual((await threadMessages(a.id)).map((m) => m.content), ['in A']);
  assert.deepEqual((await threadMessages(b.id)).map((m) => m.content), ['in B']);
  assert.deepEqual((await threadContext(a.id)).map((m) => m.content), ['in A']);
});

test('appending to a thread that does not exist returns null', async () => {
  assert.equal(await appendMessage('thr_nope', { role: 'user', content: 'x' }), null);
});
