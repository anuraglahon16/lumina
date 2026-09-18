import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';

const spaces = collection('spaces');

/**
 * A Space is a named collection of documents.
 *
 * This engine indexed documents per user and retrieved across all of them,
 * which is one Space with no name. The contract addresses documents as
 * `/spaces/:spaceId/documents`, and the distinction earns its keep beyond
 * conformance: retrieval scoped to the handful of documents a question is
 * actually about beats retrieval over everything a user ever uploaded, and
 * "everything" is not a scope anyone chose.
 */
export async function createSpace({ userId, name }) {
  return spaces.put({
    id: newId('spc'),
    user_id: userId,
    name,
    created_at: new Date().toISOString(),
  });
}

export async function getSpace(id, userId) {
  const space = await spaces.get(id);
  if (!space || (userId && space.user_id !== userId)) return null;
  return space;
}

export async function listSpaces(userId, opts = {}) {
  return spaces.list({ user_id: userId }, { limit: 100, ...opts });
}

/**
 * The Space a question should search when the caller did not name one.
 *
 * Returning null rather than inventing a default matters: a question asked with
 * no Space searches the web, and silently answering it from whichever documents
 * happened to be uploaded first would be a different answer than the one asked
 * for.
 */
export async function resolveSpace(spaceId, userId) {
  if (!spaceId) return null;
  return getSpace(spaceId, userId);
}
