import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuestion, QUESTION_KIND } from '../src/agent/core/router.js';
import { assessCoverage } from '../src/agent/core/coverage.js';

/**
 * Deciding what a question needs, without spending a model turn to decide it.
 *
 * Quick mode's latency was never the research — it was three model turns in
 * front of the research, the first of which existed only to conclude that a
 * question about the web needs a web search. That is knowable from the request.
 *
 * The rules have to be conservative in a specific direction: misrouting a
 * follow-up to the standalone path researches it without the context that makes
 * it answerable, so anything genuinely ambiguous goes to the path that does
 * more work rather than less.
 */

const classify = (query, over = {}) => classifyQuestion({ query, ...over }).kind;

/* ------------------------------------------------------- explicit choices */

test('asking for documents routes to documents, whatever the question looks like', () => {
  assert.equal(classify('what is the capital of France', { mode: 'docs' }), QUESTION_KIND.DOCUMENTS);
  assert.equal(classify('anything at all', { spaceId: 'spc_1' }), QUESTION_KIND.DOCUMENTS);
});

test('a named Space does not override an explicit request for the web', () => {
  // The caller said web. A Space lying around is not a contradiction of that.
  assert.equal(classify('what is in the news today', { mode: 'web', spaceId: 'spc_1' }), QUESTION_KIND.STANDALONE_WEB);
});

/* --------------------------------------------------- memory instructions */

test('an instruction to remember is not a question to research', () => {
  for (const q of [
    'Remember that I work in fixed income',
    'remember: I prefer metric units',
    'Please remember that my team uses Postgres',
    "Don't forget I am based in Berlin",
    'From now on, answer me in British English',
    'Forget what I told you about my job',
  ]) {
    assert.equal(classify(q), QUESTION_KIND.MEMORY_INSTRUCTION, q);
  }
});

test('"remember" inside a real question is still a question', () => {
  // The failure this avoids: a researchable question silently becoming a
  // storage instruction and never being answered.
  for (const q of [
    'Do people remember where they were during the moon landing',
    'What helps students remember vocabulary long term',
    'How much does the average person remember from a lecture',
  ]) {
    assert.notEqual(classify(q), QUESTION_KIND.MEMORY_INSTRUCTION, q);
  }
});

/* ------------------------------------------------------------ follow-ups */

test('a referential question in a conversation is a follow-up', () => {
  for (const q of ['what about the second one', 'why?', 'and the cost?', 'how does it compare', 'is that still true']) {
    assert.equal(classify(q, { threadTurns: 2 }), QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, q);
  }
});

test('a question that points at the conversation is a follow-up', () => {
  assert.equal(classify('you said throughput improves, by how much', { threadTurns: 2 }), QUESTION_KIND.CONTEXTUAL_FOLLOW_UP);
  assert.equal(classify('what did you mean earlier about latency budgets', { threadTurns: 2 }), QUESTION_KIND.CONTEXTUAL_FOLLOW_UP);
});

test('a self-contained question in a long thread is not a follow-up', () => {
  // The instruction that matters here: do not send every question in a long
  // conversation through the slow path. A question naming its own subject can
  // be researched as it stands.
  for (const q of [
    'What is the current stable release of PostgreSQL',
    'How does HTTP/3 handle head-of-line blocking',
    'What did the 2024 OWASP Top 10 change',
  ]) {
    assert.equal(classify(q, { threadTurns: 8 }), QUESTION_KIND.STANDALONE_WEB, q);
  }
});

test('a pronoun alongside its own named subject is not a follow-up', () => {
  // "it" here refers to something the question itself names.
  assert.equal(
    classify('How does Kubernetes decide when it should evict a pod', { threadTurns: 3 }),
    QUESTION_KIND.STANDALONE_WEB,
  );
});

test('with no conversation, nothing is a follow-up', () => {
  // There is nothing for a rewrite to draw on, so the slow path could only
  // guess.
  for (const q of ['why?', 'what about the other one', 'and the cost?']) {
    assert.equal(classify(q, { threadTurns: 0 }), QUESTION_KIND.STANDALONE_WEB, q);
  }
});

test('every classification says why, so a trace can show it', () => {
  const c = classifyQuestion({ query: 'why?', threadTurns: 2 });
  assert.ok(c.reason && c.reason.length > 0);
});

/* ------------------------------------------------------ evidence coverage */

const webSource = (over = {}) => ({
  type: 'web',
  url: 'https://example.com/a',
  title: 'A',
  snippet: 'PostgreSQL 17 was released in September 2024 with improvements to vacuum and query planning throughput.',
  passages: ['PostgreSQL 17 was released in September 2024. '.repeat(6)],
  ...over,
});

test('nothing read is never sufficient', () => {
  const c = assessCoverage('anything', []);
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(' '), /nothing has been read/);
});

test('two pages from one publisher are one witness, not two', () => {
  // The count that a naive sufficiency check gets wrong: same site, same press
  // release, twice.
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://example.com/one' }),
    webSource({ url: 'https://example.com/two' }),
  ]);
  assert.equal(c.publishers, 1);
});

test('subdomains of one site are still one publisher', () => {
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://docs.example.com/one' }),
    webSource({ url: 'https://blog.example.com/two' }),
  ]);
  assert.equal(c.publishers, 1);
});

test('two independent publishers covering the question is sufficient', () => {
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://one.example/a' }),
    webSource({ url: 'https://two.example/b' }),
  ]);
  assert.equal(c.ok, true, c.reasons.join('; '));
  assert.equal(c.publishers, 2);
});

test('one thorough primary source can be enough on its own', () => {
  // Demanding a second publisher regardless sends the loop hunting
  // corroboration for something already well covered, and it usually finds the
  // same press release on another site.
  const c = assessCoverage('postgresql 17 vacuum', [
    webSource({ passages: ['PostgreSQL 17 improves vacuum throughput substantially. '.repeat(10)] }),
  ]);
  assert.equal(c.ok, true, c.reasons.join('; '));
});

test('evidence that does not touch the question is not sufficient', () => {
  const c = assessCoverage('quantum error correction surface codes threshold', [
    webSource({ url: 'https://one.example/a' }),
    webSource({ url: 'https://two.example/b' }),
  ]);
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(' '), /touches/);
});

test('aggregators alone are not first-hand evidence', () => {
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://en.wikipedia.org/wiki/PostgreSQL' }),
    webSource({ url: 'https://www.reddit.com/r/postgres/x' }),
  ]);
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(' '), /aggregator/);
});

test('a question about now is not answered from years ago', () => {
  const old = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString();
  const c = assessCoverage('what is the latest postgresql release right now', [
    webSource({ url: 'https://one.example/a', published_at: old }),
    webSource({ url: 'https://two.example/b', published_at: old }),
  ]);
  assert.equal(c.ok, false);
  assert.equal(c.timeSensitive, true);
  assert.match(c.reasons.join(' '), /predate/);
});

test('undated evidence does not satisfy a question about now', () => {
  // Absence of a date is absence of evidence about recency, not evidence of
  // recency. Two undated pages could settle "the latest release" while being
  // years old, and nothing in the answer would say so.
  const c = assessCoverage('what is the latest postgresql release right now', [
    webSource({ url: 'https://one.example/a' }),
    webSource({ url: 'https://two.example/b' }),
  ]);
  assert.equal(c.timeSensitive, true);
  assert.equal(c.freshEnough, false);
  assert.equal(c.ok, false, 'so the loop goes looking for something dated');
  assert.match(c.reasons.join(' '), /carries a date/);
});

test('one dated recent source satisfies a question about now', () => {
  const fresh = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const covering = { snippet: 'PostgreSQL vacuum throughput improvements shipped in the newest release.', passages: ['PostgreSQL vacuum throughput improvements shipped in the newest release. '.repeat(6)] };
  const c = assessCoverage('what is the newest postgresql vacuum throughput improvement', [
    webSource({ url: 'https://one.example/a', published_at: fresh, ...covering }),
    webSource({ url: 'https://two.example/b', ...covering }),
  ]);
  assert.equal(c.timeSensitive, true);
  assert.equal(c.freshEnough, true, 'one dated source inside the window is enough');
  assert.equal(c.ok, true, c.reasons.join('; '));
});

test('a question with no time pressure is not asked for dates at all', () => {
  const c = assessCoverage('postgresql vacuum improvements release', [
    webSource({ url: 'https://one.example/a' }),
    webSource({ url: 'https://two.example/b' }),
  ]);
  assert.equal(c.timeSensitive, false);
  assert.equal(c.ok, true, c.reasons.join('; '));
});

test('a source with almost no text does not count as read', () => {
  const c = assessCoverage('postgresql 17 release', [
    webSource({ url: 'https://one.example/a', snippet: 'PostgreSQL', passages: [] }),
  ]);
  assert.equal(c.usable, 0);
  assert.equal(c.ok, false);
});

test('a document source counts as its own publisher', () => {
  const c = assessCoverage('append only ledger reconciliation settlement', [
    { type: 'doc', doc_id: 'd1', title: 'ledger.pdf', snippet: 'The append only ledger is reconciled against the settlement file. '.repeat(4), passages: [] },
  ]);
  assert.ok(c.publishers >= 1);
  assert.equal(c.nonAggregators, 1, 'an uploaded document is not an aggregator');
});

/* ------------------------------------------------- short, but self-contained */

test('a short question that names its subject is not a follow-up', () => {
  // Shortness alone is not a continuation. These need nothing from the
  // conversation, and routing them through a rewrite costs a model call to
  // reproduce the question that was already asked.
  for (const q of ['PostgreSQL 18 release date?', 'Claude pricing today?', 'Vercel timeout limits?', 'HTTP/3 vs QUIC?']) {
    assert.equal(classify(q, { threadTurns: 8 }), QUESTION_KIND.STANDALONE_WEB, q);
  }
});

test('a short question naming nothing is still a follow-up', () => {
  for (const q of ['why?', 'and the cost?', 'how much', 'what about that']) {
    assert.equal(classify(q, { threadTurns: 8 }), QUESTION_KIND.CONTEXTUAL_FOLLOW_UP, q);
  }
});

/* ----------------------------------------------- publishers and public suffixes */

test('unrelated sites under a multi-part suffix are separate publishers', () => {
  // The hostname shortcut reduced both of these to "co.uk" and counted two
  // unrelated newspapers as one witness — understating corroboration exactly
  // where a question is most likely to be contested.
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://www.bbc.co.uk/news/one' }),
    webSource({ url: 'https://www.theguardian.co.uk/tech/two' }),
  ]);
  assert.equal(c.publishers, 2);
});

test('subdomains of one site under a multi-part suffix are still one publisher', () => {
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://www.bbc.co.uk/news/one' }),
    webSource({ url: 'https://news.bbc.co.uk/tech/two' }),
  ]);
  assert.equal(c.publishers, 1);
});

test('coverage reports aggregator status, and does not claim to judge authority', () => {
  // The field is named for what the check measures. An SEO blog passes it, and
  // calling that "primary evidence" would be a claim the check cannot support.
  const c = assessCoverage('postgresql 17 release vacuum improvements', [
    webSource({ url: 'https://one.example/a' }),
    webSource({ url: 'https://two.example/b' }),
  ]);
  assert.equal(typeof c.nonAggregators, 'number');
  assert.equal(c.primaries, undefined, 'nothing here claims to have found a primary source');
});
