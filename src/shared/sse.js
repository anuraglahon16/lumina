/**
 * Server-Sent Events helpers shared by the agent service (producer) and the
 * gateway (forwarder).
 */

export function openSse(res, { requestId } = {}) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
  });
  res.flushHeaders?.();
  // Comment line defeats proxy buffering and confirms the stream is live.
  res.write(': lumina stream open\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref?.();
  res.on('close', () => clearInterval(heartbeat));

  let seq = 0;
  return {
    send(event, data) {
      if (res.writableEnded) return false;
      seq += 1;
      res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      return true;
    },
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * Parse an SSE byte stream into {event, data} objects. Used by the gateway to
 * observe events while forwarding, and by tests/eval to consume a run.
 */
export async function* parseSseStream(webStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of webStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        data = { raw: dataLines.join('\n') };
      }
      yield { event, data };
    }
  }
}
