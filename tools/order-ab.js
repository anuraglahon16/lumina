#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildLedger, factualAudit } from './rescore-run.js';
import { synthesizeAnswer } from '../src/agent/core/synthesize.js';
import { EvidenceLedger, isClaimAboutEvidence, locateSentences } from '../src/agent/core/evidence.js';
import { reorderPassages } from '../src/agent/core/passageOrder.js';
import { config } from '../src/shared/config.js';
import { RunRecorder } from '../src/agent/store/runLog.js';
import { acquireLock } from './diagnostic-lock.js';

/**
 * Does the order of the evidence decide whether the answer uses it?
 *
 * Adjudication found nineteen of twenty-six evidence-gap disclosures to be
 * false: the answer said the evidence did not cover the question while a
 * passage held exactly what was asked. In all three affected question groups
 * the leading passages are site navigation and the substantive text sits at
 * index three or later.
 *
 * Three arms, same evidence in all of them:
 *
 *   A  original   the order the extractor produced. The control.
 *   B  relevance  most question-term coverage first.
 *   C  content    navigation-looking passages demoted, rest by coverage.
 *
 * Nothing is removed. Dropping a passage would change what evidence exists, and
 * the result would then say that less noise helps rather than that order
 * matters — a different and much less surprising claim.
 *
 * Every question runs, not only the four that refused, because the way this
 * change fails is by burying something a question that currently works needs.
 *
 *   node tools/order-ab.js --repeats 3
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = 'reports';
const ARMS = [
  { key: 'A_original', ordering: 'original', label: 'the order the extractor produced' },
  { key: 'B_relevance', ordering: 'relevance', label: 'most question coverage first' },
  { key: 'C_content_first', ordering: 'content_first', label: 'navigation demoted, rest by coverage' },
];

/**
 * Whether the saved evidence actually answers each question.
 *
 * Declared here, before the experiment runs, because it is the denominator of
 * the primary metric and deciding it afterwards from the results would be
 * deciding it from the results.
 *
 * Nineteen of the twenty are `true` and the provenance differs: sixteen were
 * answered with citations in the baseline, which is direct proof the evidence
 * was usable; three were established by adjudication, each against a named
 * passage. The one `false` is the SSD question, whose only source is a paid
 * press release about market size.
 */
export const EVIDENCE_ANSWERS_QUESTION = {
  'How does write amplification arise in solid state drives?': {
    contains: false,
    basis: 'adjudicated: source 1 is a market press release; no passage touches write amplification',
  },
  'What does the borrow checker in Rust prevent at compile time?': {
    contains: true,
    basis: 'adjudicated: passage [1].5 reads "Prevents memory errors (use-after-free, dangling pointers, etc.) at compile time"',
  },
  'What does TLS certificate pinning protect against, and what does it break?': {
    contains: true,
    basis: 'adjudicated: passages [1].5-[1].7 define pinning and state what it breaks',
  },
  'What causes head-of-line blocking in HTTP/2 but not in HTTP/3?': {
    contains: true,
    basis: 'adjudicated: passage [1].3 reads "HTTP/3 runs over QUIC, which provides independent streams at the transport layer, eliminating both TCP..."',
  },
};

const evidenceAnswers = (query) =>
  EVIDENCE_ANSWERS_QUESTION[query] ?? {
    contains: true,
    basis: 'the baseline answered this question with citations, which is direct proof the evidence was usable',
  };

/** "I cannot answer from this evidence", in the forms answers actually use. */
const REFUSAL_PATTERNS = [
  /\bI (?:cannot|can't|could not|couldn't|don't have (?:sufficient|enough))\b[^.]{0,60}\b(?:answer|evidence|detail|information)\b/i,
  /\bI would need\b/i,
  /\b(?:the )?evidence (?:provided|given|available)?\s*(?:is|does not|doesn't|only)\b/i,
  /\b(?:does|do) not (?:contain|address|cover|explain|discuss|provide)\b/i,
];

const looksLikeRefusal = (sentence) => isClaimAboutEvidence(sentence) || REFUSAL_PATTERNS.some((re) => re.test(sentence));

/**
 * What the answer did with the evidence, decided from the answer alone.
 *
 * `full_refusal` is the one that matters: nothing cited and at least one
 * sentence saying the evidence will not support an answer. That is a reader
 * getting no answer at all.
 */
export function classifyAnswer(answer, validation) {
  const sentences = locateSentences(answer ?? '').filter((s) => !s.orphan);
  const refusals = sentences.filter((s) => looksLikeRefusal(s.text));
  const cited = validation.cited_sentences ?? 0;
  const kind = cited === 0 && refusals.length ? 'full_refusal' : refusals.length ? 'partial_disclosure' : 'answered';
  return { kind, refusal_sentences: refusals.map((s) => s.text.slice(0, 200)), cited_sentences: cited };
}

async function synthesiseOnce({ query, record, ordering, model }) {
  const { ledger: source, missing } = rebuildLedger(record);
  if (missing.length) throw new Error(`evidence for source(s) ${missing.join(', ')} was never saved`);

  // A fresh ledger whose passages are the same text in a different order.
  const ledger = new EvidenceLedger();
  const audit = [];
  for (const s of source.sources) {
    const ranked = reorderPassages(s.passages, query, ordering);
    audit.push({
      source: s.n,
      url: s.url,
      moves: ranked.map((p) => ({ from: p.from, to: p.to, features: p.features })),
    });
    ledger.restoreWebSource({ n: s.n, url: s.url, title: s.title, passages: ranked.map((p) => p.text), snippet: s.snippet });
  }

  const recorder = new RunRecorder({ requestId: 'orderab', userId: 'orderab', threadId: null, mode: 'quick', query, model });
  const started = Date.now();
  const result = await synthesizeAnswer({
    query,
    ledger,
    mode: 'quick',
    capped: false,
    capReason: null,
    evidenceLimited: false,
    evidenceGaps: null,
    memories: [],
    threadContext: null,
    researchNotes: null,
    plan: null,
    recorder,
    emit: null,
    model,
    maxTokens: config.budgets.quick.maxAnswerTokens ?? 1600,
  });

  const validation = result.validation ?? result;
  const factual = factualAudit(result.answer, validation, ledger);
  const outcome = classifyAnswer(result.answer, validation);
  const truth = evidenceAnswers(query);

  return {
    answer: result.answer,
    latency_ms: Date.now() - started,
    output_tokens: recorder.run.tokens.output,
    cost_usd: recorder.run.cost_usd,
    outcome: outcome.kind,
    refusal_sentences: outcome.refusal_sentences,
    // The primary metric. A refusal is false when the evidence held the answer.
    false_refusal: outcome.kind === 'full_refusal' && truth.contains,
    correct_refusal: outcome.kind === 'full_refusal' && !truth.contains,
    cited_sentences: validation.cited_sentences,
    supported_sentences: validation.supported_sentences,
    groundedness: validation.groundedness,
    factual_sentences: factual.factual_sentences,
    factual_sentences_cited: factual.factual_sentences_cited,
    unsupported_citations: (validation.sentence_results ?? []).filter((s) => !s.supported).length,
    passage_order: audit,
  };
}

export function summariseArm(samples) {
  const ok = samples.filter(Boolean);
  const sum = (f) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
  const cited = sum((r) => r.cited_sentences);
  const factual = sum((r) => r.factual_sentences);
  const withTruth = ok.filter((r) => r.false_refusal || r.correct_refusal || r.outcome !== 'full_refusal');

  return {
    answers: ok.length,
    // Predefined primary metric.
    false_refusals: sum((r) => (r.false_refusal ? 1 : 0)),
    false_refusal_rate: withTruth.length ? sum((r) => (r.false_refusal ? 1 : 0)) / withTruth.length : null,
    correct_refusals: sum((r) => (r.correct_refusal ? 1 : 0)),
    answered: ok.filter((r) => r.outcome === 'answered').length,
    partial_disclosures: ok.filter((r) => r.outcome === 'partial_disclosure').length,
    full_refusals: ok.filter((r) => r.outcome === 'full_refusal').length,
    pooled_grounding: cited ? sum((r) => r.supported_sentences) / cited : null,
    completeness: factual ? sum((r) => r.factual_sentences_cited) / factual : null,
    unsupported_citations: sum((r) => r.unsupported_citations),
    cited_sentences: cited,
    output_tokens: sum((r) => r.output_tokens),
    cost_usd: sum((r) => r.cost_usd),
    latency_ms: ok.length ? Math.round(sum((r) => r.latency_ms) / ok.length) : null,
  };
}

const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

export function render(report) {
  const L = [];
  const A = (line = '') => L.push(line);
  const arm = (k) => report.arms[k];

  A('# Does evidence order decide whether the answer uses it?\n');
  A('> Not a benchmark. Three orderings of identical evidence, replayed from the');
  A('> e2e0e46 run. Nothing is added or removed; only the order changes.\n');
  A(`- ran: ${report.ran_at}`);
  A(`- model: ${report.model}`);
  A(`- questions: ${report.questions}, ${report.repeats} samples per arm each`);
  A(`- answers generated: ${report.questions * report.repeats * ARMS.length}\n`);

  A('## The primary metric\n');
  A('A false refusal is an answer that declines to answer while the evidence it');
  A('was given holds what was asked. Which questions those are was declared');
  A('before the run, from adjudication and from the baseline.\n');
  A('| | A original | B relevance | C content first |');
  A('|---|---:|---:|---:|');
  A(`| **false refusals** | ${arm('A_original').false_refusals} | ${arm('B_relevance').false_refusals} | ${arm('C_content_first').false_refusals} |`);
  A(`| false refusal rate | ${fmt(arm('A_original').false_refusal_rate)} | ${fmt(arm('B_relevance').false_refusal_rate)} | ${fmt(arm('C_content_first').false_refusal_rate)} |`);
  A(`| correct refusals (evidence really absent) | ${arm('A_original').correct_refusals} | ${arm('B_relevance').correct_refusals} | ${arm('C_content_first').correct_refusals} |`);
  A('');
  A('Correct refusals must not fall. An ordering that answers the SSD question');
  A('has not improved anything; it has started answering from nothing.\n');

  A('## What the answers did\n');
  A('| | A | B | C |');
  A('|---|---:|---:|---:|');
  for (const [label, key] of [['answered outright', 'answered'], ['answered with a disclosure', 'partial_disclosures'], ['refused entirely', 'full_refusals']]) {
    A(`| ${label} | ${arm('A_original')[key]} | ${arm('B_relevance')[key]} | ${arm('C_content_first')[key]} |`);
  }
  A('');

  A('## Regressions to watch\n');
  A('| | A | B | C |');
  A('|---|---:|---:|---:|');
  A(`| pooled grounding | ${fmt(arm('A_original').pooled_grounding)} | ${fmt(arm('B_relevance').pooled_grounding)} | ${fmt(arm('C_content_first').pooled_grounding)} |`);
  A(`| citation completeness | ${fmt(arm('A_original').completeness)} | ${fmt(arm('B_relevance').completeness)} | ${fmt(arm('C_content_first').completeness)} |`);
  A(`| unsupported cited sentences | ${arm('A_original').unsupported_citations} | ${arm('B_relevance').unsupported_citations} | ${arm('C_content_first').unsupported_citations} |`);
  A(`| output tokens | ${arm('A_original').output_tokens} | ${arm('B_relevance').output_tokens} | ${arm('C_content_first').output_tokens} |`);
  A(`| cost (USD) | ${fmt(arm('A_original').cost_usd, 4)} | ${fmt(arm('B_relevance').cost_usd, 4)} | ${fmt(arm('C_content_first').cost_usd, 4)} |`);
  A(`| mean synthesis latency (ms) | ${arm('A_original').latency_ms} | ${arm('B_relevance').latency_ms} | ${arm('C_content_first').latency_ms} |`);
  A('');
  A('Reordering costs no model call and no embedding call, so any latency');
  A('difference here is the provider, not the ranker.\n');

  if (report.by_repeat?.length > 1) {
    A('## Each repeat on its own\n');
    A('| repeat | false refusals A | B | C |');
    A('|---|---:|---:|---:|');
    for (const r of report.by_repeat) {
      A(`| ${r.repeat} | ${r.A_original.false_refusals} | ${r.B_relevance.false_refusals} | ${r.C_content_first.false_refusals} |`);
    }
    A('');
  }

  A('## The four questions the hypothesis is about\n');
  A('| question | evidence holds the answer | A | B | C |');
  A('|---|---|---|---|---|');
  for (const row of report.runs) {
    const truth = EVIDENCE_ANSWERS_QUESTION[row.query];
    if (!truth) continue;
    const outcomes = (k) => (row.samples[k] ?? []).map((s) => (s.outcome === 'full_refusal' ? 'refused' : s.outcome === 'partial_disclosure' ? 'partial' : 'answered')).join(', ');
    A(`| ${row.query.slice(0, 40)} | ${truth.contains ? 'yes' : 'no'} | ${outcomes('A_original')} | ${outcomes('B_relevance')} | ${outcomes('C_content_first')} |`);
  }
  A('');
  return `${L.join('\n')}\n`;
}

async function main() {
  const runPath = flag('run', `${OUT}/grounding-diagnostic.json`);
  const repeats = Number(flag('repeats', '3'));
  const limit = Number(flag('limit', '20'));
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const model = config.llm.quickModel;

  const lock = acquireLock(OUT, { name: '.order-ab.lock' });
  const runs = [];
  try {
    for (const record of (run.runs ?? []).filter((r) => !r.error).slice(0, limit)) {
      process.stderr.write(`  ${record.query.slice(0, 50)}`);
      const row = { query: record.query, samples: Object.fromEntries(ARMS.map((a) => [a.key, []])) };
      for (let i = 0; i < repeats; i += 1) {
        // Interleaved, so a provider that degrades partway through does not
        // land entirely on one arm and read as an effect of the ordering.
        for (const a of ARMS) {
          try {
            row.samples[a.key].push(await synthesiseOnce({ query: record.query, record, ordering: a.ordering, model }));
            process.stderr.write('.');
          } catch (err) {
            row.error = `${a.key}: ${err.message}`;
          }
        }
        if (row.error) break;
      }
      process.stderr.write('\n');
      runs.push(row);
    }
  } finally {
    lock.release();
  }

  const report = {
    _LIMITATIONS: [
      'Not the official benchmark. Synthesis only, on evidence replayed from one saved run.',
      'It says nothing about retrieval: the same passages are present in every arm.',
      'The ranker is deterministic and calls no model, but its thresholds were chosen while looking at three of these twenty questions.',
    ],
    ran_at: new Date().toISOString(),
    model,
    repeats,
    questions: runs.length,
    arms: Object.fromEntries(ARMS.map((a) => [a.key, summariseArm(runs.flatMap((r) => r.samples[a.key] ?? []))])),
    by_repeat: Array.from({ length: repeats }, (_, i) => ({
      repeat: i + 1,
      ...Object.fromEntries(ARMS.map((a) => [a.key, summariseArm(runs.map((r) => r.samples[a.key]?.[i]).filter(Boolean))])),
    })),
    runs,
  };

  fs.writeFileSync(path.join(OUT, 'order-ab.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'order-ab.md'), render(report));
  console.log(`\nwrote ${OUT}/order-ab.json and .md`);
  for (const a of ARMS) {
    const s = report.arms[a.key];
    console.log(`  ${a.key.padEnd(16)} false refusals ${String(s.false_refusals).padStart(2)}  correct ${s.correct_refusals}  grounding ${fmt(s.pooled_grounding)}  completeness ${fmt(s.completeness)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
