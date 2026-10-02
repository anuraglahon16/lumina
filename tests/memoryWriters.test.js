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
