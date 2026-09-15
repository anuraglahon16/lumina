import { mongoDb } from './mongo.js';

/**
 * A collection backed by MongoDB, presenting the same interface as the JSON
 * store so callers cannot tell which one they have.
 *
 * The difference that matters is not the API but where the state lives: this
 * one is shared between processes, so two containers see the same threads,
 * memories and run logs. That is the entire reason to use it.
 *
 * `id` stays the application's key rather than Mongo's `_id`. Letting Mongo
 * mint identifiers would leak ObjectIds into API responses and run logs, and
 * the application already generates prefixed ids that say what they are.
 */
export class MongoCollection {
  constructor(name) {
    this.name = name;
    this.indexed = false;
  }

  async #col() {
    const col = (await mongoDb()).collection(this.name);
    if (!this.indexed) {
      this.indexed = true;
      // Unique on the application key, and the sort every list() uses.
      await col.createIndex({ id: 1 }, { unique: true }).catch(() => {});
      await col.createIndex({ created_at: -1 }).catch(() => {});
    }
    return col;
  }

  async get(id) {
    const col = await this.#col();
    return col.findOne({ id }, { projection: { _id: 0 } });
  }

  async put(item) {
    const col = await this.#col();
    const now = new Date().toISOString();
    const existing = await col.findOne({ id: item.id }, { projection: { _id: 0 } });
    const stored = {
      ...existing,
      ...item,
      created_at: existing?.created_at || item.created_at || now,
      updated_at: now,
    };
    await col.replaceOne({ id: stored.id }, stored, { upsert: true });
    return stored;
  }

  async patch(id, patch) {
    const existing = await this.get(id);
    if (!existing) return null;
    return this.put({ ...existing, ...patch, id });
  }

  async delete(id) {
    const col = await this.#col();
    const res = await col.deleteOne({ id });
    return res.deletedCount > 0;
  }

  async list(filter = {}, { limit = 100, offset = 0, sortKey = 'created_at', desc = true } = {}) {
    const col = await this.#col();
    const [items, total] = await Promise.all([
      col
        .find(filter, { projection: { _id: 0 } })
        .sort({ [sortKey]: desc ? -1 : 1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      col.countDocuments(filter),
    ]);
    return { total, items };
  }

  async count(filter = {}) {
    const col = await this.#col();
    return col.countDocuments(filter);
  }

  async all(filter = {}) {
    const col = await this.#col();
    return col.find(filter, { projection: { _id: 0 } }).toArray();
  }

  /** Writes land immediately, so there is nothing buffered to flush. */
  async flush() {}
}
