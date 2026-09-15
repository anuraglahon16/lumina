import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger } from '../src/agent/core/evidence.js';
import { Budget } from '../src/agent/core/budget.js';
import { chunkPages, chunkPassages } from '../src/agent/services/chunker.js';
import { parseJsonLoose, baseParams } from '../src/agent/core/llm.js';
import { normalizeAnswerStyle } from '../src/agent/core/style.js';
import { signToken, verifyToken } from '../src/shared/token.js';
import { CircuitBreaker } from '../src/shared/circuitBreaker.js';
import { validateToolInput } from '../src/agent/core/tools.js';

const fakePage = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

test('a search result is not citable until the page is actually fetched', () => {
  const ledger = new EvidenceLedger();
  ledger.noteCandidates([{ url: 'https://example.com/a', title: 'A', snippet: 'snippet only', domain: 'example.com' }]);
  assert.equal(ledger.citable.length, 0, 'snippets must never become evidence');
  assert.equal(ledger.publicCandidates().length, 1);

  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'The reactor output was 42 megawatts in the 2025 report.'.repeat(4)));
  assert.equal(ledger.citable.length, 1);
  assert.equal(ledger.publicCandidates().length, 0, 'a fetched candidate is promoted, not duplicated');
});

test('the same URL fetched twice yields one source number', () => {
  const ledger = new EvidenceLedger();
  const text = 'Shared evidence paragraph with enough length to survive the passage filter for chunking.'.repeat(2);
  const first = ledger.addWebSource(fakePage('https://example.com/x', 'X', text));
  const second = ledger.addWebSource(fakePage('https://example.com/x', 'X', text));
  assert.equal(first.n, second.n);
  assert.equal(ledger.citable.length, 1);
});

test('citations outside the ledger are stripped from the answer', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'The treaty was signed in Vienna in 1961 by twelve states.'.repeat(4)));

  const result = ledger.validate('The treaty was signed in Vienna in 1961 [1]. It had ninety signatories [7].');
  assert.deepEqual(result.cited, [1]);
  assert.deepEqual(result.invalid_citations, [7]);
  assert.ok(!result.answer.includes('[7]'), 'a hallucinated source number must never reach the user');
  assert.ok(result.answer.includes('[1]'));
});

test('groundedness falls when a sentence cites a source that does not support it', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://a.test/1', 'Solar', 'Solar photovoltaic capacity additions reached 450 gigawatts worldwide during 2024.'.repeat(4)));
  ledger.addWebSource(fakePage('https://b.test/2', 'Wind', 'Offshore wind installations in Europe expanded by 3.4 gigawatts across the year.'.repeat(4)));

  const grounded = ledger.validate('Solar photovoltaic capacity additions reached 450 gigawatts worldwide during 2024 [1].');
  assert.equal(grounded.groundedness, 1);

  const misattributed = ledger.validate('Nuclear fusion reactors achieved commercial breakeven across seventeen European facilities [2].');
  assert.ok(misattributed.groundedness < 0.5, `expected weak support, got ${misattributed.groundedness}`);
  assert.equal(misattributed.weak_citations.length, 1);
});

test('budget refuses tool calls past its limits and names the reason', () => {
  const budget = new Budget({ maxIterations: 3, maxToolCalls: 2, maxFetches: 1, maxSearches: 2, wallClockMs: 60000 });
  assert.equal(budget.allows('fetch_page').ok, true);
  budget.consume('fetch_page');
  assert.equal(budget.allows('fetch_page').reason, 'max_fetches_reached');
  budget.consume('web_search');
  assert.equal(budget.allows('web_search').reason, 'max_tool_calls_reached');
  assert.equal(budget.checkStop(), 'max_tool_calls_reached');
  assert.equal(budget.snapshot().capped, 'max_tool_calls_reached');
});

test('wall-clock exhaustion stops a run even with budget left', () => {
  const budget = new Budget({ maxIterations: 9, maxToolCalls: 9, maxFetches: 9, wallClockMs: -1 });
  assert.equal(budget.checkStop(), 'wall_clock_exceeded');
});

test('chunks never span pages, so page citations stay truthful', () => {
  const pages = [
    { page: 1, text: 'alpha '.repeat(400), label: 'p. 1' },
    { page: 2, text: 'beta '.repeat(400), label: 'p. 2' },
  ];
  const chunks = chunkPages(pages, { chunkChars: 500, overlap: 50 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    const pure = chunk.text.includes('alpha') !== chunk.text.includes('beta');
    assert.ok(pure, 'a chunk mixed content from two pages');
  }
  assert.deepEqual([...new Set(chunks.map((c) => c.page))], [1, 2]);
});

test('passage splitting keeps paragraphs whole and drops noise', () => {
  const text = ['x'.repeat(200), 'tiny', 'y'.repeat(200)].join('\n\n');
  const passages = chunkPassages(text, { maxChars: 250 });
  assert.ok(passages.length >= 2);
  assert.ok(!passages.includes('tiny'));
});

test('loose JSON parsing survives fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here is the plan: {"sub_questions":[{"id":"q1"}]} then done'), {
    sub_questions: [{ id: 'q1' }],
  });
  assert.equal(parseJsonLoose('no json at all'), null);
});

test('a failed fetch is refunded, so a blocked site cannot truncate a run', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 3, maxFetches: 3, maxSearches: 3, wallClockMs: 60000 });

  budget.consume('fetch_page');
  assert.equal(budget.refund('fetch_page', 'failed: HTTP 403'), true);
  assert.equal(budget.counts.tool_calls, 0, 'a 403 bought nothing and should cost nothing');
  assert.equal(budget.counts.fetches, 0);

  // A successful call is never refunded: it is what the budget exists to limit.
  budget.consume('fetch_page');
  budget.consume('fetch_page');
  budget.consume('fetch_page');
  assert.equal(budget.allows('fetch_page').ok, false, 'three good fetches must still exhaust the cap');
});

test('refunds are themselves capped, so repeated failures cannot buy unlimited retries', () => {
  const budget = new Budget({ maxIterations: 9, maxToolCalls: 9, maxFetches: 9, maxSearches: 9, wallClockMs: 60000, maxRefunds: 2 });
  for (let i = 0; i < 5; i += 1) {
    budget.consume('fetch_page');
    budget.refund('fetch_page', 'failed: HTTP 403');
  }
  assert.equal(budget.refunds.length, 2, 'only maxRefunds slots are ever returned');
  assert.equal(budget.counts.tool_calls, 3, 'the three unrefunded failures still cost their slot');
  assert.equal(budget.snapshot().refunded, 2);
});

test('the wall clock is never refunded, so the loop always terminates', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60000 });
  budget.deadline = Date.now() - 1;
  budget.consume('fetch_page');
  budget.refund('fetch_page', 'failed: HTTP 403');
  assert.equal(budget.checkStop(), 'wall_clock_exceeded', 'time spent is never returned');
});

test('non-tool budget dimensions are not refundable', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60000 });
  budget.consume('search_documents');
  assert.equal(budget.refund('search_documents', 'no hits'), false);
  assert.equal(budget.counts.tool_calls, 1);
});

test('markdown headings do not hide sentence boundaries from citation scoring', () => {
  const ledger = new EvidenceLedger();
  const parksText = 'The city visitors bureau lists Coronado Historic Site among its attractions. '.repeat(4);
  ledger.addWebSource(fakePage('https://example.com/parks', 'Parks', parksText));

  // The capped-run disclaimer carries no citation of its own. Glued to the next
  // sentence by a naive splitter, its words are charged against [1] and drag
  // groundedness down precisely when the answer is most honest.
  const answer = [
    '*Research was cut short by the quick mode limit, so this answer may be partial.*',
    '',
    '**In and around the city**, the visitors bureau lists Coronado Historic Site [1].',
  ].join('\n');

  const result = ledger.validate(answer);
  assert.equal(result.cited_sentences, 1, 'the uncited disclaimer must not count as a cited claim');
  assert.equal(result.groundedness, 1, 'the one cited sentence is fully supported');
});

test('paragraph breaks split sentences even when the next one starts with emphasis', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'Ramada covered picnic tables offer views of the Rio Grande valley below. '.repeat(4)));
  ledger.addWebSource(fakePage('https://example.com/b', 'B', 'Interactive maps of city parks and bike ways are published online. '.repeat(4)));

  const answer = 'Ramada covered picnic tables offer views of the Rio Grande [1].\n\n**Outdoors:** interactive maps of city parks and bike ways [2].';
  const result = ledger.validate(answer);
  assert.equal(result.cited_sentences, 2, 'two paragraphs are two sentences');
  assert.equal(result.weak_citations.length, 0, 'each claim is scored against its own source');
});

test('dashes are removed from the answer by the harness, not merely discouraged in the prompt', () => {
  const out = normalizeAnswerStyle('Rio Rancho sits north of Albuquerque — including Santa Fe [2].');
  assert.equal(out.text, 'Rio Rancho sits north of Albuquerque, including Santa Fe [2].');
  assert.equal(out.replaced, 1);
});

test('a paired dash construction collapses to commas without doubling them', () => {
  const out = normalizeAnswerStyle('It was fast — very fast — and cheap.');
  assert.equal(out.text, 'It was fast, very fast, and cheap.');
  assert.ok(!out.text.includes(',,'));
});

test('a dash between numbers is a range, so it becomes "to" rather than a comma', () => {
  assert.equal(normalizeAnswerStyle('The study ran 2020–2024.').text, 'The study ran 2020 to 2024.');
  assert.equal(normalizeAnswerStyle('Open 8:00 a.m.–1:00 p.m.').text, 'Open 8:00 a.m. to 1:00 p.m.');
});

test('quoted material is never repunctuated, because the quote must stay faithful', () => {
  // Rewriting inside quotation marks would misreport what a source said, which
  // is the one thing a citation-grounded product must never do.
  const quoted = 'The paper says "the model — as trained — fails here" [1].';
  assert.equal(normalizeAnswerStyle(quoted).text, quoted);
});

test('code spans and URLs keep their dashes', () => {
  const code = 'Run `npm run dev --flag —value` first.';
  assert.equal(normalizeAnswerStyle(code).text, code);
  const url = 'See https://example.com/a—b for details.';
  assert.equal(normalizeAnswerStyle(url).text, url);
});

test('normalisation never mistakes ordinary numbers for internal placeholders', () => {
  // A naive implementation that stashes protected spans behind bare numeric
  // markers corrupts prose like "page 7" on restore.
  const text = 'See `code` on page 7 and "a quote" on page 12 — both matter.';
  const out = normalizeAnswerStyle(text);
  assert.ok(out.text.includes('page 7'), 'a real page number survived');
  assert.ok(out.text.includes('"a quote"'), 'the quoted span was restored in place');
  assert.ok(out.text.includes('`code`'));
  assert.ok(!/[—–]/.test(out.text.replace(/"[^"]*"|`[^`]*`/g, '')));
});

test('an answer with no dashes is returned untouched', () => {
  const clean = 'Plain prose with a well-formed compound word and [1] a citation.';
  const out = normalizeAnswerStyle(clean);
  assert.equal(out.changed, false);
  assert.equal(out.text, clean);
});

test('a request is shaped for the model it is routed to, not for one model family', () => {
  // Regression: every memory extraction failed with "adaptive thinking is not
  // supported on this model" because the request was built for the Opus/Sonnet
  // shape and sent to Haiku. The extractor swallowed the error, so the feature
  // was silently dead rather than visibly broken.
  const haiku = baseParams({ model: 'claude-haiku-4-5', messages: [], maxTokens: 500 });
  assert.equal(haiku.thinking, undefined, 'haiku rejects adaptive thinking');
  assert.equal(haiku.output_config, undefined, 'haiku rejects output_config.effort');
  assert.equal(haiku.model, 'claude-haiku-4-5');

  const sonnet = baseParams({ model: 'claude-sonnet-5', messages: [], effort: 'high' });
  assert.deepEqual(sonnet.thinking, { type: 'adaptive' });
  assert.deepEqual(sonnet.output_config, { effort: 'high' });
});

test('the system prompt keeps its cache breakpoint regardless of model', () => {
  for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
    const p = baseParams({ model, system: 'stable prefix', messages: [] });
    assert.equal(p.system[0].cache_control.type, 'ephemeral', `${model} lost its cache breakpoint`);
  }
});

test('a signed identity round-trips and carries its subject', () => {
  const token = signToken({ sub: 'usr_abc123' }, 'secret-a');
  const result = verifyToken(token, 'secret-a');
  assert.equal(result.valid, true);
  assert.equal(result.claims.sub, 'usr_abc123');
});

test('a token signed with another secret is rejected', () => {
  const token = signToken({ sub: 'usr_abc123' }, 'secret-a');
  assert.deepEqual(verifyToken(token, 'secret-b'), { valid: false, reason: 'bad_signature' });
});

test('tampering with the subject invalidates the signature', () => {
  // The attack the signature exists to stop: claim to be someone else, and in
  // doing so get a fresh rate-limit bucket.
  const token = signToken({ sub: 'usr_alice' }, 'secret-a');
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'usr_bob', iat: 1 })).toString('base64url');
  const forged = `${header}.${forgedPayload}.${signature}`;
  assert.equal(verifyToken(forged, 'secret-a').valid, false);
});

test('a token declaring alg "none" is rejected rather than trusted', () => {
  // Algorithm confusion: honouring the token's own alg claim lets an attacker
  // turn off verification by asking for it.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'usr_admin' })).toString('base64url');
  assert.deepEqual(verifyToken(`${header}.${payload}.`, 'secret-a'), { valid: false, reason: 'bad_algorithm' });
});

test('an expired token is rejected', () => {
  // exp passed through the claims, since a negative ttl sets no expiry at all.
  const expired = signToken({ sub: 'usr_abc123', exp: Math.floor(Date.now() / 1000) - 60 }, 'secret-a');
  assert.deepEqual(verifyToken(expired, 'secret-a'), { valid: false, reason: 'expired' });

  const live = signToken({ sub: 'usr_abc123' }, 'secret-a', 3600);
  assert.equal(verifyToken(live, 'secret-a').valid, true, 'a live ttl still verifies');
});

test('malformed input is rejected without throwing', () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    const result = verifyToken(bad, 'secret-a');
    assert.equal(result.valid, false, `${String(bad)} should not verify`);
  }
});

const failing = () => Promise.reject(new Error('upstream exploded'));
const working = () => Promise.resolve('ok');

test('a breaker opens after the threshold and then fails fast without calling', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 3, cooldownMs: 10_000 });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(cb.run(failing));
  }
  assert.equal(cb.state, 'open');

  // The point of opening: the dependency is not called at all.
  let called = false;
  await assert.rejects(
    cb.run(() => {
      called = true;
      return working();
    }),
    (err) => err.code === 'circuit_open',
  );
  assert.equal(called, false, 'an open circuit must not reach the dependency');
});

test('a caller fault leaves the breaker closed', async () => {
  // One malformed request must not trip a breaker shared by every caller.
  const cb = new CircuitBreaker('test', {
    failureThreshold: 2,
    countsAsFailure: (err) => err.message !== 'bad request',
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(cb.run(() => Promise.reject(new Error('bad request'))));
  }
  assert.equal(cb.state, 'closed');
  assert.equal(cb.failures, 0);
});

test('after the cooldown one probe is admitted and success closes the circuit', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 0 });
  await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'open');

  assert.equal(await cb.run(working), 'ok', 'the probe is allowed through');
  assert.equal(cb.state, 'closed', 'a successful probe closes the circuit');
  assert.equal(cb.snapshot().recovered, 1);
});

test('a failed probe reopens immediately rather than waiting for the threshold again', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 5, cooldownMs: 0 });
  for (let i = 0; i < 5; i += 1) await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'open');

  await assert.rejects(cb.run(failing)); // the probe
  assert.equal(cb.state, 'open', 'one failed probe is enough to reopen');
});

test('a success resets the failure count, so scattered failures never accumulate', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 3, cooldownMs: 10_000 });
  await assert.rejects(cb.run(failing));
  await assert.rejects(cb.run(failing));
  await cb.run(working);
  await assert.rejects(cb.run(failing));
  await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'closed', 'only consecutive failures should open it');
});

test('breaker state is reportable', async () => {
  const cb = new CircuitBreaker('anthropic', { failureThreshold: 1, cooldownMs: 30_000 });
  await assert.rejects(cb.run(failing));
  const snap = cb.snapshot();
  assert.equal(snap.state, 'open');
  assert.equal(snap.last_error, 'upstream exploded');
  assert.ok(snap.retry_after_ms > 0);
  assert.equal(snap.opened, 1);
});

test('model-supplied tool arguments are validated at the boundary', () => {
  // input_schema tells the model what to send; nothing enforced that it did.
  // A missing query used to reach web_search as undefined and search for the
  // literal string "undefined".
  assert.equal(validateToolInput('web_search', { query: 'ok' }).ok, true);
  assert.equal(validateToolInput('web_search', {}).ok, false);
  assert.equal(validateToolInput('web_search', { query: '   ' }).ok, false);
  assert.equal(validateToolInput('fetch_page', { url: 123 }).ok, false);
  assert.equal(validateToolInput('remember', { content: 'x', kind: 'bogus' }).ok, false);
  assert.equal(validateToolInput('no_such_tool', {}).ok, false);
});

test('a validation failure explains itself, so the model can correct the call', () => {
  const result = validateToolInput('web_search', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /query/, 'the message must name the offending field');
});

test('validation passes through the parsed value, not the raw input', () => {
  const result = validateToolInput('web_search', { query: '  spaced  ', recency: 'recent' });
  assert.equal(result.ok, true);
  assert.equal(result.value.query, 'spaced', 'trimmed on the way through');
  assert.equal(result.value.recency, 'recent');
});
