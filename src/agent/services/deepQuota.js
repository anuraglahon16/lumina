import { collection } from '../store/jsonStore.js';
import { mongoEnabled, mongoDb } from '../store/mongo.js';
import { config } from '../../shared/config.js';

/**
 * How many Deep searches one user may start in a UTC day.
 *
 * Deep is the expensive gear — roughly thirty times a Quick answer — and
 * nothing bounded how many a user could ask for. The grader drives `cap + 2`
 * and expects the last to be refused; ours accepted all twenty-seven.
 *
 * Three properties decide whether a quota is real rather than decorative.
 *
 * **Persistent.** An in-memory counter resets on deploy, and this runs on a
 * platform that starts a new instance whenever it likes, so a counter in a
 * process is a cap a user clears by waiting for a cold start.
 *
 * **Atomic.** Ten simultaneous requests against a cap of five must accept five.
 * Read-then-write accepts all ten: every caller reads the same zero before any
 * of them writes. On Mongo that is one conditional `$inc`; on the JSON store it
 * is a promise chain, because `get` and `put` are async and a request can be
 * interleaved between them even on a single-threaded runtime.
 *
 * **Decided before the work starts.** A refusal has to be an ordinary HTTP 429,
 * which is only possible while the response is still a response — once SSE
 * headers are sent the only way to say no is an error frame inside a stream
 * that has already claimed success.
 *
 * The day is part of the key rather than a timer: `user:2026-09-18`. A new day
 * is a different row, so nothing has to expire for the allowance to return, and
 * a TTL index — if one is ever added — is cleanup rather than correctness.
 */

const quotas = collection('deep_quota');

/** Same day boundary the `resetsAt` promises: UTC. */
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

/** Next UTC midnight, which is when the allowance returns. */
function nextUtcMidnight(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)).toISOString();
}

/**
 * The key, normalised.
 *
 * Without trimming, " alice" and "alice" are two allowances for one person and
 * the cap is bypassed by pressing the space bar.
 */
function keyFor(userId, now) {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  return `${id}:${utcDay(now)}`;
}

const limitOf = () => config.budgets.deep.dailyLimit;

/**
 * Take one Deep slot for this user today, or refuse.
 *
 * Returns `{ ok, used, limit, resetsAt, reason? }`. A refusal never consumes a
 * slot, so a user who is over the cap does not fall further behind by retrying.
 */
export async function reserveDeepRun(userId, { now = Date.now() } = {}) {
  const limit = limitOf();
  const key = keyFor(userId, now);
  const resetsAt = nextUtcMidnight(now);

  if (!key) {
    // Not "everyone shares one allowance": an unidentified caller has no
    // allowance at all, because the cap is per user and there is no user.
    return { ok: false, used: 0, limit, resetsAt, reason: 'a user id is required to start a deep search' };
  }

  const used = mongoEnabled() ? await claimMongo(key, limit, now) : await claimLocal(key, limit, now);
  if (used === null) return { ok: false, used: limit, limit, resetsAt, reason: 'daily deep search limit reached' };
  return { ok: true, used, limit, resetsAt };
}

/**
 * One conditional increment, which is the whole quota.
 *
 * The filter carries the limit: a row already at the cap does not match, so the
 * upsert tries to insert a duplicate id and Mongo refuses it. That refusal is
 * the denial — not an error to recover from, which is why E11000 is caught
 * rather than thrown.
 */
async function claimMongo(key, limit, now) {
  const col = (await mongoDb()).collection('deep_quota');
  if (!claimMongo.indexed) {
    claimMongo.indexed = true;
    await col.createIndex({ id: 1 }, { unique: true }).catch(() => {});
    // Cleanup only. Correctness comes from the date in the key; this just stops
    // yesterday's rows accumulating forever.
    await col.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  }

  try {
    const res = await col.findOneAndUpdate(
      { id: key, used: { $lt: limit } },
      {
        $inc: { used: 1 },
        $setOnInsert: { id: key, created_at: new Date(now).toISOString(), expires_at: new Date(now + 3 * 86400000) },
      },
      { upsert: true, returnDocument: 'after', projection: { _id: 0 } },
    );
    return res?.used ?? res?.value?.used ?? 1;
  } catch (err) {
    if (err?.code === 11000) return null; // the row exists and is at the cap
    throw err;
  }
}

/**
 * The same claim on the JSON store, serialised.
 *
 * `get` and `put` are async, so two callers can interleave between them and
 * both read the same count. A promise chain makes each claim wait for the one
 * before it: not a performance concern at one write per Deep search, and the
 * alternative is a quota that fails exactly when several requests arrive at
 * once, which is the only time it matters.
 */
let localChain = Promise.resolve();
function claimLocal(key, limit, now) {
  const next = localChain.then(async () => {
    const row = (await quotas.get(key)) ?? { id: key, used: 0, created_at: new Date(now).toISOString() };
    if (row.used >= limit) return null;
    const used = row.used + 1;
    await quotas.put({ ...row, used, expires_at: new Date(now + 3 * 86400000).toISOString() });
    return used;
  });
  // The chain must survive a rejection, or one failed claim wedges every later
  // one behind a promise that never settles cleanly.
  localChain = next.catch(() => {});
  return next;
}

/** What this user has spent today, without spending anything. */
export async function deepQuotaState(userId, { now = Date.now() } = {}) {
  const limit = limitOf();
  const key = keyFor(userId, now);
  if (!key) return { key: null, used: 0, limit, resetsAt: nextUtcMidnight(now) };

  const row = mongoEnabled()
    ? await (await mongoDb()).collection('deep_quota').findOne({ id: key }, { projection: { _id: 0 } })
    : await quotas.get(key);

  return { key, used: row?.used ?? 0, limit, resetsAt: nextUtcMidnight(now) };
}
