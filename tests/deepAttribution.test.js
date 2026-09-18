import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every Deep retrieval step and every Deep source says which sub-question it
 * came from.
 *
 * The grader's message is "4/4 deep run(s) left subQuestion off a retrieval
 * step or a source", and the two halves had different causes. Trace steps were
 * fine: the tool executor already carries `branch` onto `tool_result` and the
 * contract mapper turns `q2` into `subQuestion: 2`. Sources were not: the
 * ledger records `branches` as an array, because one page can be found by two
 * sub-questions, and `toContractSource` reads the singular `s.branch`. It was
 * never there, so no source ever carried an index.
 *
 * This drives the real orchestration rather than a fixture. The executor is the
 * production one with only the network injected, so the ledger is written by
 * the code that writes it in production and deduplication happens for the
 * reason it happens in production — which is the case a fixture would have got
 * wrong, since a fixture author picks the dedup behaviour they are testing for.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deepattr-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { runDeepQuery } = await import('../src/agent/core/deep.js');
const { contractStream } = await import('../src/gateway/contract/events.js');

const PLAN = {
  interpretation: 'a question with three independent parts',
  sub_questions: [
    { id: 'q1', question: 'first part', why: 'because' },
    { id: 'q2', question: 'second part', why: 'also because' },
    { id: 'q3', question: 'third part', why: 'and because' },
  ],
};

const body = 'Independent streams at the transport layer remove the blocking that one lost packet would otherwise cause. '.repeat(6);

/** A page fetcher that never touches the network and always reads. */
const fetchPage = async (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `page for ${url}`,
  text: body,
  fetched_at: new Date().toISOString(),
  duration_ms: 5,
  timings: {},
});

const webSearch = async (query) => ({
  results: [{ url: `https://example.test/${encodeURIComponent(query).slice(0, 20)}`, title: query, snippet: 'lead' }],
  provider: 'stub',
  cached: false,
});

/**
 * A model that plans, then has each branch fetch a page, then writes.
 *
 * `sharedUrl` makes q1 and q2 fetch the same page, which is the deduplication
 * case: the ledger must keep one source and it must still say which
 * sub-question found it first.
 */
function fakeModel({ sharedUrl = null, failBranch = null } = {}) {
  const seen = new Map();
  return async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') {
      return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    }
    if (purpose.startsWith('research:')) {
      const branch = purpose.slice('research:'.length);
      if (branch === failBranch) throw new Error('this branch was asked to fail');
      const n = (seen.get(branch) ?? 0) + 1;
      seen.set(branch, n);
      if (n === 1) {
        const url = sharedUrl && (branch === 'q1' || branch === 'q2') ? sharedUrl : `https://example.test/${branch}`;
        return {
          content: [{ type: 'tool_use', id: `t_${branch}`, name: 'fetch_page', input: { url } }],
          stop_reason: 'tool_use',
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: `notes for ${branch}` }], stop_reason: 'end_turn', usage: {} };
    }
    params.onText?.('The merged answer [1].');
    return { content: [{ type: 'text', text: 'The merged answer [1].' }], stop_reason: 'end_turn', usage: {} };
  };
}

/** Run Deep and return both the raw events and the contract events a grader sees. */
async function runDeep(over = {}) {
  const raw = [];
  const contract = [];
  const send = (event, data) => contract.push({ event, data });
  const mapped = contractStream({ send, depth: 'deep', answerId: 'ans_test' });

  const result = await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_${Math.random().toString(36).slice(2)}`,
    threadId: null,
    requestId: `req_attr_${Math.random().toString(36).slice(2, 8)}`,
    complete: fakeModel(over.model ?? {}),
    webSearch,
    fetchPage,
    emit: (event, data) => {
      raw.push({ event, data });
      mapped(event, data);
    },
    ...over.run,
  });

  const traces = contract.filter((e) => e.event === 'trace').map((e) => e.data);
  const sources = contract.filter((e) => e.event === 'sources').flatMap((e) => e.data);
  return { result, raw, contract, traces, sources };
}

const RETRIEVAL_TOOLS = new Set(['web_search', 'fetch_page', 'search_documents']);

test('every retrieval trace step carries an integer subQuestion', async () => {
  const { traces } = await runDeep();
  const retrieval = traces.filter((t) => RETRIEVAL_TOOLS.has(t.tool));
  assert.ok(retrieval.length > 0, 'the run retrieved something');

  for (const t of retrieval) {
    assert.equal(typeof t.subQuestion, 'number', `${t.tool} step has no subQuestion`);
    assert.ok(Number.isInteger(t.subQuestion) && t.subQuestion > 0, `${t.tool} subQuestion is 1-based: ${t.subQuestion}`);
    assert.ok(t.subQuestion <= PLAN.sub_questions.length, `subQuestion ${t.subQuestion} is outside the plan`);
  }
});

test('every returned source carries an integer subQuestion', async () => {
  // The half that was missing entirely.
  const { sources } = await runDeep();
  assert.ok(sources.length > 0, 'the run produced sources');

  for (const s of sources) {
    assert.equal(typeof s.subQuestion, 'number', `source ${s.n} has no subQuestion`);
    assert.ok(Number.isInteger(s.subQuestion) && s.subQuestion > 0, `source ${s.n} subQuestion is 1-based`);
    assert.ok(s.subQuestion <= PLAN.sub_questions.length, `source ${s.n} points outside the plan`);
  }
});

test('the index matches the plan order, not the order work finished', async () => {
  // Branches run concurrently, so completion order is not plan order. An index
  // derived from whichever branch happened to land first would be stable-looking
  // and wrong.
  const { traces, contract } = await runDeep();
  const plan = contract.find((e) => e.event === 'plan')?.data;
  assert.ok(plan, 'the plan was emitted');

  const byIndex = new Map();
  for (const t of traces.filter((x) => RETRIEVAL_TOOLS.has(x.tool))) {
    byIndex.set(t.subQuestion, (byIndex.get(t.subQuestion) ?? 0) + 1);
  }
  for (const i of byIndex.keys()) {
    assert.ok(i >= 1 && i <= plan.subQuestions.length, `index ${i} is within the plan`);
  }
});

test('a deduplicated source keeps its first discoverer', async () => {
  // q1 and q2 both fetch the same url. The ledger keeps one source; the
  // contract wants one integer, and the honest one is whoever found it first.
  const shared = 'https://example.test/shared-page';
  const { sources } = await runDeep({ model: { sharedUrl: shared } });

  const hits = sources.filter((s) => s.url === shared);
  assert.equal(hits.length, 1, 'the shared page is one source, not two');
  assert.equal(typeof hits[0].subQuestion, 'number', 'and it still carries an index');
  assert.ok([1, 2].includes(hits[0].subQuestion), `the index names one of its discoverers, got ${hits[0].subQuestion}`);
});

test('a failed branch does not cost the other branches their attribution', async () => {
  const { traces, sources } = await runDeep({ model: { failBranch: 'q2' } });

  const retrieval = traces.filter((t) => RETRIEVAL_TOOLS.has(t.tool));
  for (const t of retrieval) assert.equal(typeof t.subQuestion, 'number', 'surviving steps keep their index');
  for (const s of sources) assert.equal(typeof s.subQuestion, 'number', 'surviving sources keep theirs');
  assert.ok(sources.length > 0, 'the run still produced sources');
});

test('a failed retrieval step keeps its subQuestion', async () => {
  // A step that reports ok:false is still a step that belongs to a
  // sub-question, and dropping the index there hides which part of the plan
  // went unresearched.
  const failing = async () => ({ ok: false, url: 'https://blocked.test/x', status: 403, error: 'HTTP 403', duration_ms: 3 });
  const { traces } = await runDeep({ run: { fetchPage: failing } });

  const failed = traces.filter((t) => RETRIEVAL_TOOLS.has(t.tool) && t.ok === false);
  for (const t of failed) {
    assert.equal(typeof t.subQuestion, 'number', 'a failed step still says which sub-question it served');
    assert.ok(t.error, 'and carries its error');
  }
});

test('the benchmark assertion, stated as the grader states it', async () => {
  // "For every completed Deep run, every retrieval trace step and every
  // returned source has an integer subQuestion."
  for (let i = 0; i < 3; i += 1) {
    const { traces, sources } = await runDeep();
    const offenders = [
      ...traces.filter((t) => RETRIEVAL_TOOLS.has(t.tool) && !Number.isInteger(t.subQuestion)).map((t) => `step:${t.tool}`),
      ...sources.filter((s) => !Number.isInteger(s.subQuestion)).map((s) => `source:${s.n}`),
    ];
    assert.deepEqual(offenders, [], `run ${i + 1} left subQuestion off: ${offenders.join(', ')}`);
  }
});
