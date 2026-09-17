#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { acquireLock } from './diagnostic-lock.js';

dotenv.config();

/**
 * Why cited sentences fail their support check, with the evidence kept.
 *
 * Groundedness sits at 0.86 against a 0.95 gate, and the summary that reported
 * it cannot be used to work out why: it carries the number and not the
 * sentences. A ratio is not a diagnosis. The same 0.86 is produced by a model
 * overstating what it read, by the right page having its wrong section
 * selected, by a faithful paraphrase that happens to share few words with its
 * source, and by a claim that genuinely is not supported — and those four want
 * four different repairs, one of which is to the validator rather than to the
 * system it is grading.
 *
 * So this records every cited sentence, its citation numbers, the passages the
 * cited source actually held, and the support score, and classifies the
 * failures from that evidence. The classification is a heuristic over material
 * that stays in the file, so a reader can disagree with it: nothing here is
 * asserted that cannot be checked against the sentence and the passage sitting
 * next to it.
 *
 * It changes nothing. No prompt, no threshold, no passage selection, no model.
 * Measuring and fixing in one pass would leave no way to tell which of the two
 * moved the number.
 *
 *   node tools/grounding-diagnostic.js [--queries N] [--out reports/]
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const BASE = process.env.DIAG_BASE || 'http://localhost:8787';
// The agent, directly. Run records are observability rather than product, they
// are not part of the assignment's contract, and reading them over loopback is
// what makes this diagnostic see writes from the process that made them.
const AGENT = process.env.DIAG_AGENT || 'http://localhost:8000';
const OUT = flag('out', 'reports');
const LIMIT = Number(flag('queries', 20));

/**
 * Questions chosen to need a real page read, none of them asked before in this
 * repository's measurements, and none of them drawn from the benchmark or the
 * gold set — measuring against the questions being graded would tell us only
 * how well we had memorised them.
 */
const QUERIES = [
  'How does a bloom filter trade memory for false positives in a storage engine?',
  'What does the Linux OOM killer use to score which process to terminate?',
  'How does TCP slow start decide the initial congestion window?',
  'What is the difference between a clustered and a non-clustered database index?',
  'How does the DNS resolver decide when a cached record has expired?',
  'What does a Merkle tree let a distributed system verify cheaply?',
  'How does write amplification arise in solid state drives?',
  'What problem does the two-phase commit protocol solve, and what does it cost?',
  'How does HTTP content negotiation choose a response representation?',
  'What does the borrow checker in Rust prevent at compile time?',
  'How does a JIT compiler decide that a method is hot enough to compile?',
  'What is the purpose of a write-ahead log in database crash recovery?',
  'How does consistent hashing limit the keys that move when a node leaves?',
  'What does TLS certificate pinning protect against, and what does it break?',
  'How does a copy-on-write filesystem snapshot avoid duplicating data?',
  'What causes head-of-line blocking in HTTP/2 but not in HTTP/3?',
  'How does a vector clock differ from a Lamport timestamp?',
  'What does the CAP theorem actually claim about partition tolerance?',
  'How do columnar storage formats achieve better compression than row formats?',
  'What is false sharing, and why does it slow down multicore code?',
];

const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = () => execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;

async function post(pathname, body, headers = {}) {
  const res = await fetch(new URL(pathname, BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

/** Headers the agent expects when it is reached directly rather than through the gateway. */
function agentHeaders(userId) {
  return {
    'content-type': 'application/json',
    'x-user-id': userId,
    ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
  };
}

/**
 * Ask through the agent's own API rather than the assignment's contract.
 *
 * The engine is the same one; what differs is the stream's vocabulary. The
 * contract's six events carry no run identifier — its `answerId` must match
 * `ans_…`, so a run id cannot travel there — while this one opens with
 * `run_start`, which names the run. That matters because selecting "the latest
 * run" is a guess, and a diagnostic that guesses which row it is explaining is
 * not evidence of anything.
 */
async function ask(userId, query) {
  const thread = await fetch(new URL('/v1/threads', AGENT), {
    method: 'POST',
    headers: agentHeaders(userId),
    body: JSON.stringify({ title: query.slice(0, 60) }),
  });
  if (!thread.ok) throw new Error(`POST /v1/threads -> ${thread.status}`);
  const { id: threadId } = await thread.json();

  const res = await fetch(new URL('/v1/query', AGENT), {
    method: 'POST',
    headers: agentHeaders(userId),
    body: JSON.stringify({ query, mode: 'quick', thread_id: threadId }),
  });
  if (!res.ok) throw new Error(`POST /v1/query -> ${res.status}`);

  const out = { query, answer: '', sources: [], runId: null, ttftMs: null, done: null };
  const started = Date.now();
  let event = null;
  let buffer = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) {
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event === 'run_start') out.runId = data.run_id ?? null;
        else if (event === 'sources') out.sources = data.sources ?? [];
        else if (event === 'token') {
          if (out.ttftMs === null) out.ttftMs = Date.now() - started;
          out.answer += data.text ?? '';
        } else if (event === 'answer') out.answer = data.text ?? out.answer;
        else if (event === 'done') out.done = data;
      }
    }
  }
  if (!out.runId) throw new Error('the stream never named its run');
  return out;
}

/** The exact run, by id, with the identity that owns it. */
async function fetchRun(userId, runId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const res = await fetch(new URL(`/v1/runs/${encodeURIComponent(runId)}`, AGENT), { headers: agentHeaders(userId) });
    if (res.ok) return res.json();
    if (res.status !== 404) throw new Error(`GET /v1/runs/${runId} -> ${res.status}`);
    // 404 while the write is still in flight; it is not awaited on the request
    // path, deliberately, so that a reader is not kept waiting on bookkeeping.
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`run ${runId} was never persisted, after three seconds of waiting`);
}

/**
 * Why this cited sentence failed, judged from the sentence and the passage.
 *
 * Heuristic and deliberately conservative: where the evidence does not
 * distinguish two causes it says so rather than picking one. `unclassified` is
 * a real answer and more useful than a confident wrong label, because the whole
 * point of this file is that someone can read the sentence and decide.
 */
function classify({ sentence, refs, scoredAgainst, sources, support }) {
  // The passages the validator used, falling back to the stream's sources only
  // when a run predates their being recorded.
  const cited = (scoredAgainst ?? []).length
    ? scoredAgainst.map((s) => ({ n: s.n, snippet: '', passages: s.passages ?? [] }))
    : refs.map((n) => sources.find((s) => s.n === n)).filter(Boolean);
  if (!cited.length) return { category: 'wrong_citation', note: 'the cited number matches no source in this run' };

  const words = (t) =>
    new Set(
      String(t ?? '')
        .toLowerCase()
        .replace(/\[[\d,\s]+\]/g, ' ')
        .match(/[a-z0-9]{3,}/g) ?? [],
    );

  const claim = words(sentence);
  const inCited = words(cited.map((s) => [s.snippet, ...(s.passages ?? [])].join(' ')).join(' '));
  const overlapWith = (source) => {
    const pool = words([source.snippet, ...(source.passages ?? [])].join(' '));
    let hit = 0;
    for (const w of claim) if (pool.has(w)) hit += 1;
    return claim.size ? hit / claim.size : 1;
  };

  // Does some *other* source in this run support it better than the one cited?
  const best = sources.map((s) => ({ n: s.n, score: overlapWith(s) })).sort((a, b) => b.score - a.score)[0];
  if (best && !refs.includes(best.n) && best.score >= 0.6 && best.score - support > 0.2) {
    return { category: 'wrong_citation', note: `source ${best.n} covers it better (${best.score.toFixed(2)})`, better_source: best.n };
  }

  // Two sources together, neither alone.
  if (refs.length > 1) {
    const each = refs.map((n) => overlapWith(sources.find((s) => s.n === n) ?? {}));
    const combined = (() => {
      let hit = 0;
      for (const w of claim) if (inCited.has(w)) hit += 1;
      return claim.size ? hit / claim.size : 1;
    })();
    if (combined >= 0.5 && Math.max(...each) < 0.5) {
      return { category: 'combined_source_claim', note: 'the claim spans both citations; the scorer takes the best single one' };
    }
  }

  // Numbers and names in the claim that appear nowhere in the cited text are
  // the strongest signal available here that the claim went beyond the page.
  const figures = (String(sentence).match(/\b\d[\d.,]*%?\b/g) ?? []).filter((f) => f.length > 1);
  const unsupportedFigures = figures.filter((f) => !cited.some((s) => [s.snippet, ...(s.passages ?? [])].join(' ').includes(f)));
  if (unsupportedFigures.length) {
    return { category: 'model_overstatement', note: `figures absent from the cited text: ${unsupportedFigures.join(', ')}` };
  }

  if (support >= 0.35) {
    return { category: 'tokenization_false_negative', note: 'a faithful paraphrase shares few exact words with its source' };
  }

  const anySourceCovers = sources.some((s) => overlapWith(s) >= 0.5);
  if (!anySourceCovers) {
    return { category: 'missing_passage_or_unsupported', note: 'no source in this run covers the claim; either the wrong section was selected or nothing supports it' };
  }

  return { category: 'unclassified', note: 'the evidence here does not separate the causes; read the sentence against the passage' };
}

/** Sentences that assert something checkable, for the completeness metric. */
function factualSentences(answer) {
  return String(answer ?? '')
    .split(/\n{2,}|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
    .flatMap((block) => block.split(/(?<=[.!?])["')\]]*[*_]*\s+(?=[*_#>\-]*\s*[A-Z0-9"'(\[])/))
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.replace(/\[[\d,\s]+\]/g, '').trim().split(/\s+/).length >= 6)
    .filter((s) => !/^\*?_?(?:research was cut short|the answer was cut short)/i.test(s));
}

async function main() {
  const commit = sha();
  if (dirty()) {
    console.error('The working tree is dirty. This has to run from a clean commit or the numbers cannot be reproduced.');
    process.exit(1);
  }

  const lock = acquireLock(OUT, { name: '.grounding-diagnostic.lock' });
  try {
    await collectAll(commit);
  } finally {
    lock.release();
  }
}

async function collectAll(commit) {
  // From the process the questions go to. Reading health from the gateway
  // while asking the agent describes a configuration that may not be the one
  // under test.
  const health = await fetch(new URL('/v1/health', AGENT)).then((r) => r.json()).catch(() => ({}));
  const runs = [];

  for (const query of QUERIES.slice(0, LIMIT)) {
    const userId = `diag_${Math.random().toString(36).slice(2, 10)}`;
    process.stderr.write(`  ${query.slice(0, 58)}\n`);
    try {
      const result = await ask(userId, query);
      const { sources, answer, done } = result;

      /**
       * Read from the run the system itself recorded, not re-derived here.
       *
       * The first version of this rebuilt a ledger from the sources on the
       * stream and re-scored the answer against them. Those carry a
       * four-hundred character snippet, while the validator scores against the
       * full passages the page was read into — so almost every sentence failed
       * and the file reported 0.19 for a system measuring 0.86. The instrument
       * was wrong, not the thing it was pointed at, and a diagnostic that
       * computes its own version of the number it is diagnosing can only
       * disagree with the system for reasons of its own making.
       */
      const record = await fetchRun(userId, result.runId);
      const citations = record.citations ?? {};

      const factual = factualSentences(answer);
      const factualCited = factual.filter((s) => /\[\d/.test(s)).length;

      runs.push({
        commit,
        query,
        model: done?.model ?? null,
        answer,
        sources: sources.map((s) => ({ n: s.n, kind: s.kind, title: s.title, url: s.url ?? null, snippet: s.snippet })),
        cited_sentences: citations.cited_sentences ?? null,
        supported_sentences: citations.supported_sentences ?? null,
        cited_sources: citations.valid ?? null,
        markers_emitted: citations.emitted ?? null,
        groundedness: citations.groundedness ?? null,
        factual_sentences: factual.length,
        factual_sentences_cited: factualCited,
        // Classified against the passages the validator scored, not against the
        // four-hundred character snippet on the stream. Scoring one thing and
        // explaining another is how a citation supported by material further
        // down a page gets filed as unsupported.
        sentence_results: citations.sentence_results ?? [],
        weak_citations: (citations.sentence_results ?? [])
          .filter((r) => !r.supported)
          .map((r) => ({
            sentence: r.sentence,
            refs: r.refs,
            support_score: r.best_score,
            scored_against: r.scored_against,
            ...classify({ sentence: r.sentence, refs: r.refs, scoredAgainst: r.scored_against, sources, support: r.best_score }),
          })),
        sources_fetched: record.sources?.fetched ?? null,
        warnings: (record.warnings ?? []).map((x) => x.code),
        /**
         * Named for what it is. These questions go straight to the agent, so
         * this excludes the gateway, the translation into the contract's
         * events, the proxy's streaming and anything the deployment adds. It
         * is useful for comparing one diagnostic run with another and is not
         * the number the 2.5 second gate is about; that one has to come through
         * the deployed contract path.
         */
        agent_direct_ttft_ms: result.ttftMs,
        latency_ms: done?.latencyMs ?? null,
        cost_usd: done?.costUsd ?? null,
        terminated: done?.terminated ?? null,
        search_cached: done?.searchCached ?? null,
      });
    } catch (err) {
      runs.push({ commit, query, error: err.message });
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const raw = {
    commit,
    ran_at: new Date().toISOString(),
    base: BASE,
    node: process.version,
    health: normaliseHealth(health),
    runs,
  };
  fs.writeFileSync(path.join(OUT, 'grounding-diagnostic.json'), `${JSON.stringify(raw, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'grounding-diagnostic.md'), render(raw));
  console.log(`\nwrote ${OUT}/grounding-diagnostic.json and .md`);
}

/**
 * The agent's health, in the shape this report stores.
 *
 * The endpoint nests everything worth knowing under `checks`, and the earlier
 * version read `health.searchProvider` and `health.vectorStore` — fields that do
 * not exist on it. The fetch was right and the reading was wrong, so the report
 * described the provider as "unknown" while querying a process that knew
 * perfectly well. A run whose configuration is unrecorded cannot be compared
 * with another.
 */
export function normaliseHealth(health) {
  const checks = health?.checks ?? {};
  return {
    model: health?.model ?? null,
    search_provider: checks.search_provider ?? null,
    search_degraded: checks.search_degraded ?? null,
    store: checks.store ?? null,
    vector_backend: checks.vector_backend ?? null,
    embedding_provider: checks.embedding_provider ?? null,
  };
}

/** The summary, computed from the JSON rather than typed alongside it. */
function render({ commit, ran_at, node, health, runs }) {
  const ok = runs.filter((r) => !r.error);
  const sum = (f) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
  // Pooled over sentences, which is what the ratio is made of. An earlier
  // version divided by the count of distinct cited *sources*, producing a
  // number that looked like grounding, read higher than the truth, and was not
  // a grounding ratio at all.
  const totalCited = sum((r) => r.cited_sentences);
  const aggregate = totalCited ? sum((r) => r.supported_sentences) / totalCited : null;
  const perRun = ok.map((r) => r.groundedness).filter((g) => typeof g === 'number');
  const mean = perRun.length ? perRun.reduce((a, b) => a + b, 0) / perRun.length : null;
  const completeness = sum((r) => r.factual_sentences_cited) / (sum((r) => r.factual_sentences) || 1);

  const categories = {};
  for (const r of ok) for (const w of r.weak_citations ?? []) categories[w.category] = (categories[w.category] ?? 0) + 1;

  const L = [];
  const A = (s = '') => L.push(s);
  A('# Grounding diagnostic\n');
  A(`- commit: \`${commit}\``);
  A(`- ran at: ${ran_at}`);
  A(`- node: ${node}`);
  A(`- answer model: ${health?.model ?? 'unknown'}`);
  A(`- store: ${health?.store ?? 'unknown'} · vectors: ${health?.vector_backend ?? 'unknown'} · embeddings: ${health?.embedding_provider ?? 'unknown'}`);
  A(`- search provider: ${health?.search_provider ?? 'unknown'}${health?.search_degraded ? ' (degraded)' : ''}`);
  A(`- questions: ${ok.length} answered, ${runs.length - ok.length} failed\n`);
  A('Nothing was changed to produce this: no prompt, no threshold, no passage');
  A('selection, no model. It measures the state at the commit named above.\n');

  A('## Two different numbers, reported separately\n');
  A('| metric | value | gate |');
  A('|---|---:|---:|');
  A(`| aggregate grounding (supported ÷ cited sentences, pooled) | ${aggregate === null ? '—' : aggregate.toFixed(3)} | 0.95 |`);
  A(`| mean run grounding (mean of per-run ratios) | ${mean === null ? '—' : mean.toFixed(3)} | 0.95 |`);
  A(`| citation completeness (factual sentences cited ÷ factual) | ${completeness.toFixed(3)} | — |`);
  A('');
  A('These are not interchangeable. Pooling weights a long answer more heavily');
  A('than a short one; the mean of ratios treats a run that cited one sentence');
  A('perfectly as equal to a run that cited twenty. Completeness is separate');
  A('again, and it is the one that catches a system scoring 1.00 grounding by');
  A('citing a single safe sentence and leaving everything else uncited.\n');

  A('## Why cited sentences failed\n');
  if (!Object.keys(categories).length) A('No weak citations in this run.\n');
  else {
    A('| category | count | what it would mean |');
    A('|---|---:|---|');
    const meaning = {
      missing_passage_or_unsupported: 'right page, wrong section selected — or nothing supports it',
      model_overstatement: 'the answer went past what the cited text says',
      wrong_citation: 'the evidence exists in this run, under another number',
      combined_source_claim: 'the claim spans two citations; the scorer takes the best single one',
      tokenization_false_negative: 'a faithful paraphrase sharing few exact words',
      unclassified: 'the evidence does not separate the causes',
    };
    for (const [cat, n] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
      A(`| ${cat} | ${n} | ${meaning[cat] ?? ''} |`);
    }
    A('');
    A('The classification is a heuristic. Every sentence and the passage it was');
    A('scored against are in the JSON, so a reader can disagree with any row.\n');
  }

  A('## Per run\n');
  A('| question | cited | supported | grounding | factual cited | weak |');
  A('|---|---:|---:|---:|---:|---:|');
  for (const r of ok) {
    A(
      `| ${r.query.slice(0, 52)} | ${r.cited_sentences ?? '—'} | ${r.supported_sentences ?? '—'} | ${
        r.groundedness ?? '—'
      } | ${r.factual_sentences_cited}/${r.factual_sentences} | ${r.weak_citations.length} |`,
    );
  }
  A('');
  A('## Caveats\n');
  A('- One pass per question, one machine, one network. Not the official benchmark.');
  A('- Questions go straight to the agent, so `agent_direct_ttft_ms` excludes the');
  A('  gateway and the contract translation. It is not the gated TTFT and must not');
  A('  be compared with the 2.5 second target.');
  A('- The scorer is lexical overlap against the passages a source carried, not entailment.');
  A('- Questions were chosen to need a page read and are not drawn from the benchmark or the gold set.');
  return `${L.join('\n')}\n`;
}

// Only when run, not when imported. Its helpers are worth testing, and a module
// that starts a twenty question measurement on import cannot be.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
