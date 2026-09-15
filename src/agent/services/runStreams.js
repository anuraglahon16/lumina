import { EventEmitter } from 'node:events';

/**
 * Buffered event stream for detached (background) runs.
 *
 * A Deep Search started with `async: true` keeps producing events after the
 * HTTP request that started it is gone. Subscribers replay the buffer, then
 * follow live, so a browser can close the tab, come back, and see the whole run.
 */
class RunStream extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.events = [];
    this.closed = false;
    this.setMaxListeners(0);
  }

  push(event, data) {
    if (this.closed) return;
    const entry = { seq: this.events.length + 1, at: Date.now(), event, data };
    this.events.push(entry);
    this.emit('event', entry);
  }

  close() {
    this.closed = true;
    this.emit('closed');
  }

  /** Replay from `fromSeq`, then follow. Returns an unsubscribe function. */
  subscribe(handler, fromSeq = 0) {
    for (const entry of this.events) if (entry.seq > fromSeq) handler(entry);
    if (this.closed) {
      handler({ seq: this.events.length + 1, event: '_closed', data: {} });
      return () => {};
    }
    const onEvent = (entry) => handler(entry);
    const onClosed = () => handler({ seq: this.events.length + 1, event: '_closed', data: {} });
    this.on('event', onEvent);
    this.once('closed', onClosed);
    return () => {
      this.off('event', onEvent);
      this.off('closed', onClosed);
    };
  }
}

const streams = new Map();

export function createRunStream(id) {
  const stream = new RunStream(id);
  streams.set(id, stream);
  // Keep finished runs replayable for a while, then reclaim memory.
  setTimeout(() => streams.delete(id), 60 * 60 * 1000).unref?.();
  return stream;
}

export const getRunStream = (id) => streams.get(id) || null;
