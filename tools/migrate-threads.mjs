/**
 * Move embedded thread messages into the `messages` collection, and give both
 * collections the camelCase fields the contract and the declared indexes use.
 *
 * Dry run by default; `--apply` writes; `--prune` additionally drops the old
 * embedded array once the split is trusted.
 *
 * Idempotent, including from a half-finished run. Each message is written under
 * a deterministic id derived from its thread and its position, so a pass that
 * died between inserting messages and updating the header finishes rather than
 * duplicating. A thread with no `messages` array has already been split and is
 * skipped.
 *
 * Nothing is deleted without `--prune`: the array stays on the header, so the
 * rollback is "ignore the new collection".
 */
import { MongoClient } from 'mongodb';
import { toContractSource } from '../src/agent/core/contractSource.js';

const APPLY = process.argv.includes('--apply');
const PRUNE = process.argv.includes('--prune');
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;

if (!uri || !dbName) {
  console.error('MONGODB_URI and MONGODB_DB are required');
  process.exit(2);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const threads = db.collection('threads');
const messages = db.collection('messages');

const plan = {
  db: dbName,
  threads: { total: 0, withEmbedded: 0, alreadySplit: 0, missingCamelCase: 0, missingCount: 0 },
  messages: { toInsert: 0, alreadyPresent: 0, existingRows: 0, missingCamelCase: 0 },
  prune: { arraysToDrop: 0 },
  // Threads whose Mongo _id is not the thread id. Immutable, so the migration
  // reports them rather than claiming it can fix them.
  notes: { threadsKeepingObjectIdUnderscoreId: 0 },
  nonConforming: { messagesWithRunIdAsAnswerId: 0, messagesWithLedgerShapedSources: 0 },
};

plan.threads.total = await threads.countDocuments({});
plan.messages.existingRows = await messages.countDocuments({});

const work = [];
for await (const t of threads.find({})) {
  const embedded = Array.isArray(t.messages) ? t.messages : null;
  if (embedded) plan.threads.withEmbedded += 1;
  else plan.threads.alreadySplit += 1;
  if (!t.userId || !t.createdAt || !t.lastActivityAt) plan.threads.missingCamelCase += 1;
  if (typeof t.messageCount !== 'number') plan.threads.missingCount += 1;
  if (t._id !== t.id) plan.notes.threadsKeepingObjectIdUnderscoreId += 1;

  const rows = (embedded ?? []).map((m, i) => ({
    // Deterministic: re-running cannot create a second copy of the same turn.
    id: `${t.id}:m${i + 1}`,
    _id: `${t.id}:m${i + 1}`,
    thread_id: t.id,
    threadId: t.id,
    user_id: t.user_id,
    userId: t.user_id,
    seq: i + 1,
    role: m.role,
    content: m.content ?? '',
    // Contract-shaped, like a freshly appended message. The ledger shape was
    // what the embedded array held, and persisting it unchanged is why 0 of 82
    // migrated messages validated against MessageDoc.
    sources: (m.sources ?? []).map(toContractSource),
    /**
     * `run_id` only. It is a `run_…`, and `MessageDoc.answerId` is branded
     * `ans_…`, so copying it across made every migrated message invalid on that
     * field. The answer ids of these historical runs were never persisted
     * anywhere, so there is nothing truthful to put here - the field is left
     * absent rather than filled with the wrong id.
     */
    ...(m.run_id ? { run_id: m.run_id } : {}),
    ...(m.mode ? { mode: m.mode } : {}),
    ...(m.citations ? { citations: m.citations } : {}),
    ...(m.capped !== undefined ? { capped: m.capped } : {}),
    // The original timestamp, whichever field held it. A migrated turn keeps
    // when it happened; only its position is newly explicit.
    createdAt: m.at ?? m.created_at ?? t.created_at ?? new Date(0).toISOString(),
    at: m.at ?? m.created_at ?? t.created_at ?? new Date(0).toISOString(),
    created_at: m.at ?? m.created_at ?? t.created_at ?? new Date(0).toISOString(),
  }));

  for (const r of rows) {
    if (await messages.countDocuments({ id: r.id }, { limit: 1 })) plan.messages.alreadyPresent += 1;
    else plan.messages.toInsert += 1;
  }
  if (embedded) plan.prune.arraysToDrop += 1;
  work.push({ thread: t, rows, embedded });
}

// Rows already in the collection that predate the camelCase fields.
plan.nonConforming.messagesWithRunIdAsAnswerId = await messages.countDocuments({ answerId: { $regex: '^run_' } });
/**
 * `$type: 'null'` and not `null`.
 *
 * In Mongo a query for `null` also matches a MISSING field, and a web source
 * legitimately has no `locator` - so this reported 39 non-conforming messages
 * after the repair had already fixed all of them. The detector was the thing
 * that was wrong; validating against `MessageDoc` showed 82/82 conforming.
 */
plan.nonConforming.messagesWithLedgerShapedSources = await messages.countDocuments({
  $or: [{ 'sources.type': { $exists: true } }, { 'sources.locator': { $type: 'null' } }],
});
plan.messages.missingCamelCase = await messages.countDocuments({
  $or: [{ threadId: { $exists: false } }, { userId: { $exists: false } }, { createdAt: { $exists: false } }, { seq: { $exists: false } }],
});

console.log(JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log('\ndry run — nothing written. Re-run with --apply (and --prune to drop the old arrays).');
  await client.close();
  process.exit(0);
}

let inserted = 0;
let headers = 0;
let pruned = 0;
for (const { thread, rows, embedded } of work) {
  for (const r of rows) {
    const res = await messages.updateOne({ id: r.id }, { $setOnInsert: r }, { upsert: true });
    if (res.upsertedCount) inserted += 1;
  }
  /**
   * `_id` is not set here, and cannot be.
   *
   * `ThreadDoc._id` is the thread id, and `createThread` writes it that way for
   * new threads. Mongo's `_id` is immutable, so an existing document cannot be
   * given one in place - it would have to be deleted and reinserted. Migrated
   * threads therefore keep their ObjectId `_id` and carry the id under `id`,
   * which is the field every reader and this store use; the application never
   * sees `_id` at all, because `MongoCollection` projects it away. Stated rather
   * than papered over with a differently-named field.
   */
  const set = {
    userId: thread.user_id,
    createdAt: thread.createdAt ?? thread.created_at ?? new Date(0).toISOString(),
    lastActivityAt: thread.lastActivityAt ?? thread.last_activity_at ?? thread.created_at ?? new Date(0).toISOString(),
    // The count comes from the rows that exist, not from the array, so a
    // re-run after a partial pass converges on the truth.
    messageCount: await messages.countDocuments({ thread_id: thread.id }),
  };
  await threads.updateOne({ id: thread.id }, { $set: set });
  headers += 1;
  if (PRUNE && embedded) {
    await threads.updateOne({ id: thread.id }, { $unset: { messages: '' } });
    pruned += 1;
  }
}

// Rows that were already in the collection but lack the new fields.
for await (const m of messages.find({ $or: [{ threadId: { $exists: false } }, { userId: { $exists: false } }] })) {
  await messages.updateOne(
    { id: m.id },
    { $set: { threadId: m.thread_id, userId: m.user_id, createdAt: m.createdAt ?? m.at ?? m.created_at } },
  );
}

/**
 * Repair rows this script's earlier version wrote.
 *
 * It copied `run_id` into `answerId` and stored sources in the ledger's shape,
 * so the first apply produced 82 messages of which none validated. Both are
 * fixed in place: `answerId` is unset where it does not look like an answer id,
 * and a ledger-shaped source is mapped. Keyed on the defect rather than on a
 * version marker, so it is a no-op once clean.
 */
let repaired = 0;
for await (const m of messages.find({
  $or: [{ answerId: { $exists: true } }, { 'sources.type': { $exists: true } }, { 'sources.locator': { $type: 'null' } }],
})) {
  const update = {};
  if (m.answerId && !String(m.answerId).startsWith('ans_')) update.$unset = { answerId: '' };
  const needsSources = (m.sources ?? []).some((s) => s && (s.type !== undefined || s.locator === null || s.kind === undefined));
  if (needsSources) update.$set = { sources: (m.sources ?? []).map(toContractSource) };
  if (!Object.keys(update).length) continue;
  await messages.updateOne({ id: m.id }, update);
  repaired += 1;
}
if (repaired) console.log(JSON.stringify({ repaired }, null, 2));

console.log(JSON.stringify({ applied: { messagesInserted: inserted, headersUpdated: headers, arraysPruned: pruned } }, null, 2));
await client.close();
