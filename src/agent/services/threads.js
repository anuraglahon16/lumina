import { config } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';

const threads = collection('threads');

/**
 * Thread memory: the running conversation. Distinct from long-term memory,
 * this is verbatim, scoped to one thread, and never promoted automatically
 * without passing through extraction.
 */
export function createThread({ userId, title }) {
  return threads.put({
    id: newId('thr'),
    user_id: userId,
    title: title || 'New thread',
    messages: [],
    last_activity_at: new Date().toISOString(),
  });
}

export function getThread(id, userId) {
  const thread = threads.get(id);
  if (!thread || (userId && thread.user_id !== userId)) return null;
  return thread;
}

export function ensureThread({ threadId, userId, title }) {
  const existing = threadId ? getThread(threadId, userId) : null;
  return existing || createThread({ userId, title });
}

export function appendMessage(threadId, message) {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const entry = { id: newId('msg'), at: new Date().toISOString(), ...message };
  const messages = [...thread.messages, entry];
  const patch = { messages, last_activity_at: entry.at };
  // First user turn names the thread.
  if (thread.title === 'New thread' && message.role === 'user' && message.content) {
    patch.title = message.content.slice(0, 80);
  }
  threads.put({ ...thread, ...patch });
  return entry;
}

/** Recent turns, condensed into plain message params for the model. */
export function threadContext(threadId, { window = config.memory.threadWindow } = {}) {
  const thread = threads.get(threadId);
  if (!thread) return [];
  return thread.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-window)
    .map((m) => ({ role: m.role, content: m.content }));
}

export function listThreads(userId, opts = {}) {
  const { total, items } = threads.list((t) => t.user_id === userId, { sortKey: 'last_activity_at', limit: 50, ...opts });
  return {
    total,
    items: items.map((t) => ({
      id: t.id,
      title: t.title,
      message_count: t.messages.length,
      created_at: t.created_at,
      last_activity_at: t.last_activity_at,
    })),
  };
}

export function deleteThread(id, userId) {
  const thread = getThread(id, userId);
  if (!thread) return false;
  return threads.delete(id);
}
