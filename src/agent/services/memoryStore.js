import { config } from '../../shared/config.js';
import { newId, sha256 } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { embedBatch, embedQuery, cosine, tokenize } from './embeddings.js';

const memories = collection('memories');

export const MEMORY_KINDS = ['preference', 'fact', 'project', 'constraint'];

/**
 * Long-term memory: durable, user-scoped facts that survive threads. Every
 * entry records where it came from, so the UI can show provenance and the user
 * can delete anything they disagree with.
 */
export async function saveMemory({ userId, content, kind = 'fact', source = 'agent', threadId = null, runId = null, confidence = 0.8 }) {
  const text = content.trim();
  if (!text) return null;

  // De-duplicate on exact text, and near-duplicate on embedding similarity.
  const fingerprint = sha256(`${userId}:${text.toLowerCase()}`);
  const exact = (await memories.all({ user_id: userId, fingerprint }))[0] || null;
  if (exact) {
    return memories.put({ ...exact, hits: (exact.hits || 0) + 1, last_seen_at: new Date().toISOString() });
  }

  const { vectors } = await embedBatch([text], { inputType: 'document' });
  const embedding = vectors[0];

  const near = (await memories.all({ user_id: userId }))
    .map((m) => ({ m, sim: cosine(embedding, m.embedding) }))
    .sort((a, b) => b.sim - a.sim)[0];
  if (near && near.sim > 0.95) {
    return memories.put({ ...near.m, hits: (near.m.hits || 0) + 1, last_seen_at: new Date().toISOString() });
  }

  const record = await memories.put({
    id: newId('mem'),
    user_id: userId,
    content: text,
    kind: MEMORY_KINDS.includes(kind) ? kind : 'fact',
    source,
    thread_id: threadId,
    run_id: runId,
    confidence,
    hits: 0,
    last_seen_at: new Date().toISOString(),
    tokens: tokenize(text),
    embedding,
  });

  // Bounded store: evict the least useful (oldest, least-hit) beyond the cap.
  const all = await memories.all({ user_id: userId });
  if (all.length > config.memory.maxLongTerm) {
    all
      .sort((a, b) => (a.hits || 0) - (b.hits || 0) || String(a.last_seen_at).localeCompare(String(b.last_seen_at)))
      .slice(0, all.length - config.memory.maxLongTerm)
      .forEach((m) => memories.delete(m.id));
  }
  return record;
}

export async function searchMemories(query, { userId, topK = config.memory.injectTopK } = {}) {
  const pool = await memories.all({ user_id: userId });
  if (!pool.length) return [];
  const { vector, provider } = await embedQuery(query);
  const queryTerms = new Set(tokenize(query));

  // With the local (lexical) embedder the cosine and the overlap measure the
  // same thing, so term overlap carries most of the weight; a real embedding
  // provider earns the opposite split.
  const denseWeight = provider === 'local' ? 0.4 : 0.75;
  const floor = provider === 'local' ? 0.06 : 0.12;

  return pool
    .map((m) => {
      const terms = m.tokens?.length ? new Set(m.tokens) : new Set();
      let shared = 0;
      for (const t of queryTerms) if (terms.has(t)) shared += 1;
      // Symmetric overlap: a short memory matching a long query still scores.
      const overlap = queryTerms.size && terms.size ? shared / Math.min(queryTerms.size, terms.size) : 0;
      return { memory: m, score: denseWeight * cosine(vector, m.embedding) + (1 - denseWeight) * overlap };
    })
    .filter((r) => r.score > floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => ({ ...publicMemory(r.memory), score: Number(r.score.toFixed(4)) }));
}

export async function listMemories(userId, opts = {}) {
  const { total, items } = await memories.list({ user_id: userId }, { limit: 200, ...opts });
  return { total, items: items.map(publicMemory) };
}

export async function deleteMemory(id, userId) {
  const m = await memories.get(id);
  if (!m || m.user_id !== userId) return false;
  return memories.delete(id);
}

export async function clearMemories(userId) {
  const mine = await memories.all({ user_id: userId });
  for (const m of mine) await memories.delete(m.id);
  return mine.length;
}

/** Never ship embeddings or token lists to the client. */
function publicMemory(m) {
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    source: m.source,
    thread_id: m.thread_id,
    run_id: m.run_id,
    confidence: m.confidence,
    hits: m.hits,
    created_at: m.created_at,
    last_seen_at: m.last_seen_at,
  };
}
