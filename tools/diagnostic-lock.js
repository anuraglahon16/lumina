import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * One diagnostic at a time, and only the holder may release it.
 *
 * Four copies of a diagnostic once ran at once against one gateway and one run
 * log, because each new attempt was started without stopping the last. They
 * interleaved and the report described no single run of anything.
 *
 * The first version of this checked for a stale lock and then overwrote it,
 * which is two steps with a gap between them: two processes finding the same
 * dead lock both decide to take it, and both write, and both believe they hold
 * it. Recovery removes the dead file and then competes for an exclusive
 * create, so the winner is decided by the filesystem rather than by timing.
 *
 * The token is what makes release safe. Without it, a process finishing late
 * deletes whatever lock is present, including one a different process has
 * since taken.
 */
export function acquireLock(dir, { name = '.diagnostic.lock' } = {}) {
  const lockFile = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomUUID();
  const mine = JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() });

  const tryCreate = () => {
    try {
      fs.writeFileSync(lockFile, mine, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryCreate()) {
    recoverStaleLock(lockFile, tryCreate);
  }

  return {
    token,
    release() {
      const current = readLock(lockFile);
      // Only if it is still ours. A late finisher must not delete a lock
      // someone else is holding.
      if (current?.token === token) fs.rmSync(lockFile, { force: true });
      return current?.token === token;
    },
  };
}

/**
 * Take over a lock whose owner is gone, one process at a time.
 *
 * Checking for staleness and then overwriting is two steps with a gap. Several
 * processes read the same dead lock, each decides it may take it, and each
 * removes whatever file is present — including the perfectly live lock another
 * of them created a moment earlier. The exclusive create does not save you,
 * because the deletion happens first.
 *
 * So recovery itself is serialised behind a second lock. Only the holder of the
 * recovery mutex may look at the primary lock and decide it is dead, which
 * means the observation and the action it justifies cannot be separated by
 * another process's work. The ordinary path never touches this: it is reached
 * only after a create has already failed.
 */
function recoverStaleLock(lockFile, tryCreate) {
  const recoveryFile = `${lockFile}.recovery`;
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });

  try {
    fs.writeFileSync(recoveryFile, mine, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = readLock(recoveryFile);
    if (holder && isAlive(holder.pid)) {
      throw new Error(`another diagnostic is recovering the lock (pid ${holder.pid})`);
    }
    // The recovery mutex is itself stale. Clear it and try once; whoever wins
    // the create proceeds and everyone else is told to stop.
    fs.rmSync(recoveryFile, { force: true });
    try {
      fs.writeFileSync(recoveryFile, mine, { flag: 'wx' });
    } catch (retryErr) {
      if (retryErr.code !== 'EEXIST') throw retryErr;
      throw new Error('another diagnostic is recovering the lock');
    }
  }

  try {
    // Re-read *after* holding the mutex. The earlier read is worthless: it
    // described the world before anyone had the right to act on it.
    const held = readLock(lockFile);
    if (held && isAlive(held.pid)) {
      throw new Error(`another diagnostic holds the lock (pid ${held.pid}, since ${held.started})`);
    }
    if (held) fs.rmSync(lockFile, { force: true });
    if (!tryCreate()) {
      const now = readLock(lockFile);
      throw new Error(`another diagnostic took the lock first (pid ${now?.pid ?? 'unknown'})`);
    }
  } finally {
    fs.rmSync(recoveryFile, { force: true });
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Signal 0 asks whether a process exists without disturbing it. */
function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return err.code === 'EPERM';
  }
}
