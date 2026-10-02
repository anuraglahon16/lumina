import { config } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { asContractSource } from '../core/contractSource.js';

const threads = collection('threads');
const messages = collection('messages');

/**
 * Thread memory: the running conversation.
 *
 * Distinct from long-term memory — this is verbatim, scoped to one thread, and
 * never promoted automatically without passing through extraction.
 *
 * Messages used to live in a `messages` array on the thread document, which made
 * every append a read-modify-write: read the thread, concatenate, write the whole
 * thing back. Two appends landing together both read the same array and the
 * second overwrote the first, so a turn could vanish — and the cost of appending
 * grew with the length of the conversation, because the entire history was
 * rewritten each time. `scripts/indexes.json` also declares
 * `messages: { threadId: 1, createdAt: 1 }`, an index over a collection that did
 * not exist.
 *
 * So a thread is now a header and its messages are their own documents. An append
 * is one insert plus one `$set`/`$inc`, neither of which reads first.
 *
 * Both spellings are written. `packages/contract/src/db.ts` defines `ThreadDoc`
 * and `MessageDoc` in camelCase with `_id`, and `scripts/indexes.json` — neither
 * of them ours to edit — declares its indexes that way; every reader in this
 * codebase, and the store abstraction that stamps `created_at`, uses snake_case.
 * Both schemas are non-strict `z.object`s, so a document carrying both validates
 * against the contract. Renaming instead would be a single change touching every
 * reader, and the readers are the part that works.
 */
export async function createThread({ userId, title }) {
  const id = newId('thr');
  const now = new Date().toISOString();
  return threads.put({
    id,
    // ThreadDoc._id is the thread id, not a separate surrogate.
    _id: id,
    user_id: userId,
    userId,
    title: title || 'New thread',
    createdAt: now,
    lastActivityAt: now,
    last_activity_at: now,
    // Maintained by $inc, so it never disagrees with the collection for the
    // reason a recomputed count would.
    messageCount: 0,
  });
}

export async function getThread(id, userId) {
  const thread = await threads.get(id);
  if (!thread || (userId && thread.user_id !== userId)) return null;
  return thread;
}

export async function ensureThread({ threadId, userId, title }) {
  const existing = threadId ? await getThread(threadId, userId) : null;
  return existing || createThread({ userId, title });
}

/**
 * Append one message: an insert, then an update. No read of either document.
 *
 * The title is set on the first user turn, and only while it is still the
 * default — expressed as a condition on the header read that `ensureThread`
 * already did, rather than as a fresh read here.
 */
export async function appendMessage(threadId, message) {
  const thread = await threads.get(threadId);
  if (!thread) return null;

  const at = new Date().toISOString();
  const set = { lastActivityAt: at, last_activity_at: at };
  // First user turn names the thread.
  if (thread.title === 'New thread' && message.role === 'user' && message.content) {
    set.title = message.content.slice(0, 80);
  }

  /**
   * Increment first, and let the new count be the message's position.
   *
   * Ordering a conversation by `createdAt` is ordering it by a millisecond
   * clock, and two turns can share a millisecond - which is not hypothetical:
   * twenty appends in a test landed in the same millisecond, the sort found them
   * all equal, and the "last four turns" handed to the model were the first
   * four, backwards. Under load the same tie is possible in production between a
   * question and the turn that follows it.
   *
   * `$inc` returns a value no other append can also receive, so `seq` is a total
   * order within the thread and the sort has nothing to be ambiguous about. The
   * cost of doing it in this order is that an insert failing after the increment
   * leaves the count one high - a number slightly wrong, against a transcript in
   * the wrong order, which is the worse of the two.
   */
  const header = await threads.bump(threadId, { set, inc: { messageCount: 1 } });
  const seq = header?.messageCount ?? 0;

  const id = newId('msg');
  const { run_id: runId, answerId, sources, ...rest } = message;
  return messages.insert({
    id,
    _id: id,
    thread_id: threadId,
    threadId,
    user_id: thread.user_id,
    userId: thread.user_id,
    // Position within the thread, 1-based. What the transcript sorts on.
    seq,
    /**
     * Stored in the contract's shape, which is also the shape the user was shown.
     *
     * The ledger's own shape was persisted and converted on the way out, so what
     * was in the database never matched `MessageDoc.sources`: `type` instead of
     * `kind`, a null `locator`, `doc_id` instead of `docId`. Validating the
     * migrated collection is what surfaced it - 0 of 82 messages conformed, while
     * a unit test passed because the message it validated had no sources at all.
     */
    sources: (sources ?? []).map(asContractSource),
    /**
     * `answerId` is the `ans_…` the route minted for this answer, not the run id.
     *
     * This stored `answerId: run_id`, which is a `run_…` - the contract brands
     * `AnswerId` as `ans_`, so every stored message failed validation on it and
     * the id the `done` event gave the client matched nothing in the transcript.
     * The route generates the answer id and now hands it to the run.
     */
    ...(runId ? { run_id: runId } : {}),
    ...(answerId ? { answerId } : {}),
    ...rest,
    createdAt: at,
    // The field the old shape used. Kept because stored messages carry it and a
    // reader that wants "when" should not have to know which era wrote the row.
    at,
  });
}

/**
 * Recent turns, condensed into plain message params for the model.
 *
 * Newest-first with a limit, then reversed: the window is the last N turns, and
 * asking the database for the last N is a different query from reading every
 * message and slicing. On a long thread the old form loaded the whole history to
 * use eight of it.
 */
export async function threadContext(threadId, { window = config.memory.threadWindow } = {}) {
  const { items } = await messages.list(
    { thread_id: threadId },
    // By `seq`, not by time: see appendMessage. A millisecond is not a position.
    { sortKey: 'seq', desc: true, limit: window * 2 },
  );
  return items
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(0, window)
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Every message in a thread, oldest first. The transcript, for the thread view. */
export async function threadMessages(threadId, { limit = 500 } = {}) {
  const { items } = await messages.list({ thread_id: threadId }, { sortKey: 'seq', desc: false, limit });
  return items;
}

export async function listThreads(userId, opts = {}) {
  const { total, items } = await threads.list({ user_id: userId }, { sortKey: 'last_activity_at', limit: 50, ...opts });
  return {
    total,
    items: items.map((t) => ({
      id: t.id,
      title: t.title,
      // From the header. Counting the collection per thread would be one query
      // per row in a list endpoint.
      message_count: t.messageCount ?? 0,
      created_at: t.created_at,
      last_activity_at: t.last_activity_at,
    })),
  };
}

export async function deleteThread(id, userId) {
  const thread = await getThread(id, userId);
  if (!thread) return false;
  // The messages are their own documents now, so deleting the header alone would
  // leave them behind — invisible, counted by nothing, and still in the index.
  const { items } = await messages.list({ thread_id: id }, { limit: 10000 });
  for (const m of items) await messages.delete(m.id);
  return threads.delete(id);
}
