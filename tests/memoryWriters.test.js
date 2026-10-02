import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Long-term memory is written by an explicit save_memory call, and nothing else.
 *
 * A post-run extractor inferred durable facts and saved them. They appeared in
 * /memory, so nothing was hidden - but nobody asked for them, and the spec is
 * explicit that an explicit call is the only writer. Measured in Atlas before
 * this change: 235 of 237 stored memories came from the extractor and 2 from a
 * real save_memory call. The violation was not marginal; it was almost all of
 * the memory in the system.
 *
 * The extractor stays behind the flag rather than being deleted. It is useful,
 * and whether to run it is a policy decision rather than a bug.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-memwriters-'));
process.env.MONGODB_URI = '';
delete process.env.MEMORY_EXTRACT_ENABLED;

const { config } = await import('../src/shared/config.js');
const { extractMemories } = await import('../src/agent/core/memoryExtractor.js');

test('the extractor is off unless someone turns it on', () => {
  assert.equal(config.memory.extractEnabled, false, 'inferred memory must be opt-in');
});

test('the committed default is false, not just the local environment', () => {
  const src = fs.readFileSync(new URL('../src/shared/config.js', import.meta.url), 'utf8');
  assert.match(src, /extractEnabled: bool\(process\.env\.MEMORY_EXTRACT_ENABLED, false\)/);
});

test('with the flag off the extractor writes nothing and says nothing', async () => {
  const emitted = [];
  const saved = await extractMemories({
    userId: 'usr_mem',
    query: 'I am writing a thesis on retrieval-augmented generation',
    answer: 'Noted.',
    emit: (event, data) => emitted.push([event, data]),
  });
  assert.deepEqual(saved, [], 'nothing saved');
  assert.deepEqual(emitted, [], 'and no memory_saved event, which would imply it had');
});

test('the extractor still exists, behind the flag', () => {
  // Deleting it would be a different decision than disabling it.
  const src = fs.readFileSync(new URL('../src/agent/core/memoryExtractor.js', import.meta.url), 'utf8');
  assert.match(src, /saveMemory/, 'the code path is intact');
  assert.match(src, /config\.memory\.extractEnabled/, 'and gated on the flag');
});

/* ------------------------------------------- recall inside the index's lag window */

/**
 * A memory saved a moment ago is still recalled.
 *
 * Atlas Search is eventually consistent. Measured against the deployed cluster:
 * `saveMemory` returns, and the memory is not searchable through
 * `memories_vector` for roughly another half second. `save_memory` followed by a
 * recall inside the same run sits inside that window, so recall through the
 * index alone returned nothing for a memory the user had just been told was
 * saved - and `GET /memory` listed it the whole time, which is the contradiction
 * that makes it a defect rather than a tuning choice.
 *
 * Driven through the `nearest` seam rather than against a live cluster: an index
 * that answers "nothing" is the whole of what the lag looks like from here.
 */
test('a memory the index has not caught up with is still recalled', async () => {
  const { saveMemory, searchMemories, clearMemories } = await import('../src/agent/services/memoryStore.js');
  const userId = `usr_lag_${Math.random().toString(36).slice(2, 8)}`;
  await clearMemories(userId);
  await saveMemory({ userId, content: 'Prefers answers in metric units, never imperial.', kind: 'preference', source: 'agent' });

  // The index, lagging: it answers, and it has nothing.
  const lagging = async () => [];
  const recalled = await searchMemories('what units should I use?', { userId, topK: 3, nearest: lagging });

  assert.ok(recalled.length > 0, 'an empty index answer must be confirmed against the primary, not returned');
  assert.match(recalled[0].content, /metric/, 'and the memory that exists is the one recalled');
});

test('a user with no memories still gets an empty list, not a scan result', async () => {
  const { searchMemories, clearMemories } = await import('../src/agent/services/memoryStore.js');
  const userId = `usr_empty_${Math.random().toString(36).slice(2, 8)}`;
  await clearMemories(userId);
  const recalled = await searchMemories('anything at all', { userId, topK: 3, nearest: async () => [] });
  assert.deepEqual(recalled, [], 'nothing saved means nothing recalled');
});

test('recall prefers the index when it answers', async () => {
  // The backstop must not become the path: it reads every memory the user has.
  const { saveMemory, searchMemories, clearMemories } = await import('../src/agent/services/memoryStore.js');
  const userId = `usr_idx_${Math.random().toString(36).slice(2, 8)}`;
  await clearMemories(userId);
  const saved = await saveMemory({ userId, content: 'Prefers metric units.', kind: 'preference', source: 'agent' });

  let scanned = false;
  const answering = async () => {
    scanned = true;
    return [{ ...saved, score: 0.91 }];
  };
  const recalled = await searchMemories('units?', { userId, topK: 3, nearest: answering });
  assert.ok(scanned, 'the index was asked');
  assert.equal(recalled.length, 1, 'and its answer was used');
  assert.equal(recalled[0].id, saved.id);
});
