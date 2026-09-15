import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, sortable-ish, URL-safe id with a type prefix (run_, thr_, doc_, ...). */
export function newId(prefix) {
  const ts = Date.now().toString(36).padStart(8, '0');
  const rand = randomBytes(6);
  let tail = '';
  for (const b of rand) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${ts}${tail}`;
}

export function sha256(input) {
  return createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex');
}

/** Stable cache key: short hash of a namespace plus a canonicalised payload. */
export function cacheKey(namespace, payload) {
  return `${namespace}:${sha256(payload).slice(0, 32)}`;
}
