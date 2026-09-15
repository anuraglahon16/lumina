/**
 * End-to-end smoke test against a running gateway.
 * Covers every path that does not need a model key, plus the SSE plumbing.
 *
 *   npm run smoke            # expects `npm run dev` in another terminal
 */
import { signToken } from '../src/shared/token.js';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const USER = `usr_smoke${Date.now().toString(36)}`;

/**
 * A signed deployment ignores `x-user-id`, so the suite must present the same
 * credential a real client would. Without this the isolation checks would still
 * pass while testing nothing: every request would land on a different freshly
 * minted identity, and of course one stranger cannot see another's data.
 */
const SECRET = process.env.AUTH_SECRET || '';
const authHeaders = (userId) =>
  SECRET ? { authorization: `Bearer ${signToken({ sub: userId }, SECRET, 3600)}` } : { 'x-user-id': userId };

let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail ? `· ${detail}` : ''}`);
  }
};

const call = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(USER), ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...options.headers },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
};

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function main() {
  section('health & capabilities');
  const health = await call('/health');
  check('gateway /health responds', health.status === 200 || health.status === 503, `status ${health.status}`);
  check('gateway reports agent health', Boolean(health.json?.agent?.checks), JSON.stringify(health.json?.agent).slice(0, 120));
  const caps = await call('/api/capabilities');
  check('capabilities lists active providers', Boolean(caps.json?.active?.search), JSON.stringify(caps.json?.active));
  check('secrets are never returned', !JSON.stringify(caps.json).includes('sk-'), 'a key-like string appeared in the response');

  section('identity & validation');
  check('request id is echoed', Boolean(health.headers.get('x-request-id')));
  const bad = await call('/api/query', { method: 'POST', body: JSON.stringify({ query: 'x' }) });
  check('short query is rejected at the gateway', bad.status === 400, `status ${bad.status}`);
  const badMode = await call('/api/query', { method: 'POST', body: JSON.stringify({ query: 'valid question here', mode: 'turbo' }) });
  check('unknown mode is rejected', badMode.status === 400, `status ${badMode.status}`);

  section('threads');
  const thread = await call('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'smoke thread' }) });
  check('thread created', thread.status === 201 && thread.json.id?.startsWith('thr_'));
  const threads = await call('/api/threads');
  check('thread listed', threads.json.items?.some((t) => t.id === thread.json.id));
  const delThread = await call(`/api/threads/${thread.json.id}`, { method: 'DELETE' });
  check('thread deleted', delThread.status === 204);

  section('long-term memory');
  const mem = await call('/api/memories', { method: 'POST', body: JSON.stringify({ content: 'Prefers answers with tables and no preamble.', kind: 'preference' }) });
  check('memory saved', mem.status === 201 && mem.json.id?.startsWith('mem_'));
  const memList = await call('/api/memories');
  check('memory is visible', memList.json.items?.some((m) => m.id === mem.json.id));
  check('memory never exposes its embedding', !JSON.stringify(memList.json).includes('embedding'));
  const memSearch = await call('/api/memories?q=how%20should%20answers%20be%20formatted');
  check('memory is retrievable by meaning', memSearch.json.items?.length > 0, JSON.stringify(memSearch.json).slice(0, 100));
  const memDel = await call(`/api/memories/${mem.json.id}`, { method: 'DELETE' });
  check('memory is deletable', memDel.status === 204);
  const memGone = await call('/api/memories');
  check('deleted memory is gone', !memGone.json.items?.some((m) => m.id === mem.json.id));

  section('document upload → async indexing → RAG');
  const body = [
    'LUMINA Operations Handbook',
    '',
    'Section 1. Quick mode is capped at six tool calls and four page fetches. When a run reaches a cap it reports the cap honestly rather than pretending the research was complete.',
    '',
    'Section 2. Deep Search plans sub-questions, researches each one in its own branch, sweeps for cross-branch evidence, and merges all citations into a single numbering.',
    '',
    'Section 3. The gateway enforces rate limits per user with separate token buckets for quick and deep requests, because a Deep Search costs orders of magnitude more than a quick answer.',
  ].join('\n');
  const form = new FormData();
  form.append('files', new Blob([body], { type: 'text/plain' }), 'handbook.txt');
  const upload = await call('/api/documents', { method: 'POST', body: form });
  check('upload returns 202 immediately (async)', upload.status === 202, `status ${upload.status} ${upload.text.slice(0, 150)}`);
  const docId = upload.json?.accepted?.[0]?.id;
  check('document id issued', Boolean(docId));

  let doc = null;
  for (let i = 0; i < 40 && docId; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    doc = (await call(`/api/documents/${docId}`)).json;
    if (doc?.status === 'indexed' || doc?.status === 'failed') break;
  }
  check('document reached indexed state', doc?.status === 'indexed', `status=${doc?.status} error=${doc?.error}`);
  check('chunks were produced', doc?.chunk_count > 0, `chunks=${doc?.chunk_count}`);
  check('pages were tracked for citation', doc?.page_count > 0, `pages=${doc?.page_count}`);

  const rag = await call('/api/documents/search/query?q=what+happens+when+quick+mode+hits+a+cap');
  check('RAG retrieves a relevant passage', rag.json?.results?.length > 0, JSON.stringify(rag.json).slice(0, 120));
  check('retrieved passage carries a page locator', Boolean(rag.json?.results?.[0]?.page_label), JSON.stringify(rag.json?.results?.[0]).slice(0, 150));
  check(
    'top passage is the one that answers the query',
    /cap/i.test(rag.json?.results?.[0]?.text || ''),
    (rag.json?.results?.[0]?.text || '').slice(0, 80),
  );

  section('run logs');
  const runs = await call('/api/runs');
  check('run list responds', Array.isArray(runs.json?.items));
  const stats = await call('/api/runs/stats');
  check('run stats responds', typeof stats.json?.runs === 'number');

  section('SSE plumbing');
  const sse = await fetch(`${BASE}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(USER) },
    body: JSON.stringify({ query: 'Does the streaming transport work end to end?', mode: 'quick' }),
  });
  const isStream = (sse.headers.get('content-type') || '').includes('event-stream');
  if (isStream) {
    const text = await sse.text();
    const events = [...text.matchAll(/event: (\w+)/g)].map((m) => m[1]);
    check('SSE stream established through the gateway', true);
    check('run_start is the first event', events[0] === 'run_start', events.slice(0, 5).join(','));
    const sourcesIdx = events.indexOf('sources');
    const tokenIdx = events.indexOf('token');
    if (tokenIdx !== -1) {
      check('sources are emitted before answer tokens', sourcesIdx !== -1 && sourcesIdx < tokenIdx, `sources@${sourcesIdx} token@${tokenIdx}`);
      check('run terminates with a done event', events.includes('done'));
    } else {
      check('run reported an error cleanly (no model key configured)', events.includes('error') && events.includes('done'), events.join(','));
    }
  } else {
    check('query returned a structured error without a model key', sse.status >= 400, `status ${sse.status}`);
  }

  section('rate limiting');
  const burst = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('/api/query', { method: 'POST', body: JSON.stringify({ query: 'rate limit probe question', mode: 'deep' }) }),
    ),
  );
  const limited = burst.filter((r) => r.status === 429);
  check('deep-mode burst is rate limited', limited.length > 0, `${limited.length}/6 limited`);
  check('429 carries retry-after', limited.length === 0 || Boolean(limited[0].headers.get('retry-after')));

  section('isolation');
  const otherUser = await fetch(`${BASE}/api/memories`, { headers: authHeaders(`${USER}_other`) }).then((r) => r.json());
  check("another user cannot see this user's memories", (otherUser.items || []).length === 0);
  const otherDocs = await fetch(`${BASE}/api/documents`, { headers: authHeaders(`${USER}_other`) }).then((r) => r.json());
  check("another user cannot see this user's documents", (otherDocs.items || []).length === 0);

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke run crashed:', err.message);
  console.error('Is the stack running? Start it with `npm run dev`.');
  process.exit(1);
});
