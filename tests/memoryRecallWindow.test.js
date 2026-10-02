import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The recall fallback covers the indexing lag and nothing else.
 *
 * When `$vectorSearch` answers "nothing", that is either true or the index has
 * not caught up with a write made moments ago. Only the second is a defect, so
 * the fallback reads only memories created inside a short window. A full scan
 * there would grow with how much a user remembers and would hide a broken index
 * behind acceptable answers.
 *
 * Its own file because the window has to be shorter than the test: `created_at`
 * is immutable on update in both stores - `existing?.created_at || ...` - so a
 * record cannot be aged by writing to it, and the window is read from config at
 * import. One millisecond makes everything saved "old" a moment later.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-memwindow-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';
process.env.MEMORY_RECENT_WRITE_WINDOW_MS = '1';

const { saveMemory, searchMemories, clearMemories } = await import('../src/agent/services/memoryStore.js');
const { collection } = await import('../src/agent/store/jsonStore.js');
const { config } = await import('../src/shared/config.js');

test('the window is configurable and this file shortened it', () => {
  assert.equal(config.memory.recentWriteWindowMs, 1, 'otherwise nothing below is outside the window');
});

test('fifty memories older than the window are not scanned when the index answers empty', async () => {
  const userId = `usr_fifty_${Math.random().toString(36).slice(2, 8)}`;
  await clearMemories(userId);

  /**
   * Deliberately relevant to the query below.
   *
   * An earlier version stored fifty memories about widgets, which a scan would
   * have scored below the floor anyway - so it passed with the fallback widened
   * back to a full scan and proved only that one read happened. A memory a scan
   * WOULD return is what makes an empty result evidence.
   */
  for (let i = 0; i < 50; i += 1) {
    await saveMemory({
      userId,
      content: `Standing preference ${i}: answers should use metric units, never imperial.`,
      kind: 'preference',
      source: 'agent',
    });
  }
  const stored = await collection('memories').all({ user_id: userId });
  assert.ok(stored.length >= 10, `the fixture stored ${stored.length} memories to scan past`);

  // Past the window.
  await new Promise((r) => setTimeout(r, 20));

  const memories = collection('memories');
  const realAll = memories.all.bind(memories);
  let reads = 0;
  memories.all = async (filter) => {
    reads += 1;
    return realAll(filter);
  };
  try {
    const recalled = await searchMemories('what units should I use?', { userId, topK: 3, nearest: async () => [] });
    assert.deepEqual(
      recalled.map((m) => m.content),
      [],
      'every one of these would score well on a scan, so anything returned came from one',
    );
    assert.equal(reads, 1, `the fallback made ${reads} reads of the collection`);
  } finally {
    memories.all = realAll;
  }
});

test('a memory inside the window is still recalled', async () => {
  // The other half: narrowing must not remove the behaviour it narrows.
  const userId = `usr_fresh_${Math.random().toString(36).slice(2, 8)}`;
  await clearMemories(userId);
  await saveMemory({ userId, content: 'Prefers answers in metric units, never imperial.', kind: 'preference', source: 'agent' });

  // No wait: the save just happened, so it is inside even a 1ms window.
  const recalled = await searchMemories('what units should I use?', { userId, topK: 3, nearest: async () => [] });
  assert.ok(recalled.length > 0, 'a just-written memory is recalled despite the index not knowing it');
  assert.match(recalled[0].content, /metric/);
});
