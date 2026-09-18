import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { matchesFilter } from './filter.js';
import { mongoEnabled } from './mongo.js';
import { MongoCollection } from './mongoCollection.js';

/** Codes that mean "this disk will not take writes", not "this write was wrong". */
const UNWRITABLE = new Set(['ENOENT', 'EROFS', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOSPC']);

/**
 * Tiny persistent document store: one JSON file per collection, loaded into
 * memory at boot, written back atomically and debounced. Deliberately
 * dependency-free. Swapping in Postgres/SQLite later means reimplementing
 * this one module, nothing else.
 */
export class Collection {
  constructor(name, { dir = config.agent.dataDir } = {}) {
    this.name = name;
    this.file = path.join(dir, `${name}.json`);
    this.dir = dir;
    this.items = new Map();
    this.dirty = false;
    this.flushTimer = null;
    // Set before #load, which is what discovers it.
    this.memoryOnly = false;
    this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      /**
       * A filesystem that refuses to be written to costs persistence, not the
       * process.
       *
       * `runLog.js` already states this intent and then defeats it by building
       * its collection at module scope: on a serverless bundle without
       * MONGODB_URI, everything outside /tmp is read-only, the constructor
       * threw `ENOENT: mkdir '/var/task/data'` during import, and the function
       * died before any route ran. The deployment reported READY and answered
       * FUNCTION_INVOCATION_FAILED on every path.
       *
       * Degrading to memory is honest here because the rows were never going
       * to outlive the instance anyway — a serverless disk is per-invocation.
       * It is not a substitute for Mongo, and the warning says so once.
       */
      this.memoryOnly = true;
      process.stderr.write(`[store] ${this.name} is memory-only: cannot write ${this.dir} (${err.code})\n`);
      return;
    }
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of parsed) this.items.set(item.id, item);
    } catch (err) {
      // A corrupt file must not take the service down; keep a copy and start clean.
      fs.renameSync(this.file, `${this.file}.corrupt.${Date.now()}`);
      process.stderr.write(`[store] ${this.name} was corrupt (${err.message}); quarantined\n`);
    }
  }

  #scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => process.stderr.write(`[store] flush ${this.name}: ${err.message}\n`));
    }, 120);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (!this.dirty || this.memoryOnly) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp.${process.pid}`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify([...this.items.values()], null, 0));
      await fsp.rename(tmp, this.file);
    } catch (err) {
      // A directory that was writable at boot and is not now. Same bargain as
      // above: keep serving from memory rather than reject into a caller that
      // only wanted to save a row.
      if (!UNWRITABLE.has(err.code)) throw err;
      this.memoryOnly = true;
      process.stderr.write(`[store] ${this.name} is memory-only: cannot write ${this.dir} (${err.code})\n`);
    }
  }

  async get(id) {
    return this.items.get(id) || null;
  }

  async put(item) {
    const now = new Date().toISOString();
    const existing = this.items.get(item.id);
    const stored = { ...existing, ...item, created_at: existing?.created_at || item.created_at || now, updated_at: now };
    this.items.set(stored.id, stored);
    this.#scheduleFlush();
    return stored;
  }

  async patch(id, patch) {
    const existing = this.items.get(id);
    if (!existing) return null;
    return this.put({ ...existing, ...patch, id });
  }

  async delete(id) {
    const had = this.items.delete(id);
    if (had) this.#scheduleFlush();
    return had;
  }

  /** Filter + newest-first, with a hard limit so a big store can't blow a response. */
  async list(filter = {}, { limit = 100, offset = 0, sortKey = 'created_at', desc = true } = {}) {
    const all = [...this.items.values()].filter((item) => matchesFilter(item, filter));
    all.sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * (desc ? -1 : 1);
    });
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }

  async count(filter = {}) {
    let n = 0;
    for (const item of this.items.values()) if (matchesFilter(item, filter)) n += 1;
    return n;
  }

  /** Every matching row, for callers that must scan (BM25 over a corpus). */
  async all(filter = {}) {
    return [...this.items.values()].filter((item) => matchesFilter(item, filter));
  }
}

const registry = new Map();

/**
 * Collections are singletons per process so two routes never fork state.
 *
 * Which backend you get depends only on whether MONGODB_URI is set. Callers are
 * written against one interface and never branch on it, which is what keeps the
 * choice a deployment decision rather than a code change.
 */
export function collection(name) {
  if (!registry.has(name)) {
    registry.set(name, mongoEnabled() ? new MongoCollection(name) : new Collection(name));
  }
  return registry.get(name);
}

export async function flushAll() {
  await Promise.all([...registry.values()].map((c) => c.flush()));
}
