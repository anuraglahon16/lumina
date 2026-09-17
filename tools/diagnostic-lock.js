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
    const held = readLock(lockFile);
    if (held && isAlive(held.pid)) {
      throw new Error(`another diagnostic holds the lock (pid ${held.pid}, since ${held.started})`);
    }
    // Stale. Remove it and compete for the create; whoever wins, wins.
    if (held) fs.rmSync(lockFile, { force: true });
    if (!tryCreate()) {
      const now = readLock(lockFile);
      throw new Error(`another diagnostic took the lock first (pid ${now?.pid ?? 'unknown'})`);
    }
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
