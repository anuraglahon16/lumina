#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildLedger, factualAudit } from './rescore-run.js';
import { synthesizeAnswer } from '../src/agent/core/synthesize.js';
import { config } from '../src/shared/config.js';
import { isClaimAboutEvidence } from '../src/agent/core/evidence.js';
import { acquireLock } from './diagnostic-lock.js';
import { RunRecorder } from '../src/agent/store/runLog.js';

/**
 * The citation contract, A against B, on evidence that cannot move.
 *
 * A prompt change measured by asking twenty questions twice is not measured at
 * all. Between the two runs the web moves, search returns different pages, and
 * different evidence reaches synthesis — so a completeness figure that improved
 * might mean the prompt worked, or might mean the second run happened to fetch
 * better pages. Those are indistinguishable afterwards, and the difference
 * being looked for here is smaller than that noise.
 *
 * So retrieval is not re-run. Each question's ledger is rebuilt from the
 * passages the e2e0e46 run saved, and the *same* ledger is handed to synthesis
 * twice: once with the prompt that produced the 0.910 baseline, once with the
 * granularity contract. Same evidence, same model, same question, same
 * validator. One variable.
 *
 * What this cannot tell you: whether the contract survives evidence that this
 * run never gathered. It is a controlled comparison on a fixed sample of
 * twenty, not a benchmark, and it is not a substitute for a traced run.
 *
 *   node tools/prompt-ab.js --run reports/grounding-diagnostic.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = 'reports';
const VARIANTS = [
  { key: 'legacy', label: 'the prompt that produced the 0.910 baseline', contract: 'legacy' },
  { key: 'granular', label: 'one citation per factual sentence, canonical placement', contract: 'granular' },
];

/** Synthesise one answer from a fixed ledger, and measure it. */
async function synthesiseOnce({ query, ledger, contract, model }) {
  const started = Date.now();
  // A recorder purely to collect usage and cost: the SDK reports them to the
  // recorder, not to the caller, and the token cost of this change is one of
  // the things being measured.
  const recorder = new RunRecorder({ requestId: 'ab', userId: 'ab', threadId: null, mode: 'quick', query, model });
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
    contract,
  });

  const validation = result.validation ?? result;
  const usage = {
    input_tokens: recorder.run.tokens.input,
    output_tokens: recorder.run.tokens.output,
  };
  const audit = factualAudit(result.answer, validation, ledger);

  // Sentences that cite a block which does not support them. This is the
  // number that has to be watched while pushing for completeness: a prompt
  // demanding a citation per sentence can buy the second metric with these.
  const unsupported = (validation.sentence_results ?? []).filter((s) => !s.supported);

  return {
    answer: result.answer,
    latency_ms: Date.now() - started,
    usage,
    cost_usd: recorder.run.cost_usd,
    cited_sentences: validation.cited_sentences,
    supported_sentences: validation.supported_sentences,
    groundedness: validation.groundedness,
    orphan_citations: (validation.orphan_citations ?? []).length,
    unsupported_citations: unsupported.map((s) => ({ sentence: s.sentence.slice(0, 200), refs: s.refs, best_score: s.best_score })),
    factual_sentences: audit.factual_sentences,
    factual_sentences_cited: audit.factual_sentences_cited,
    factual_sentences_excluding_disclosures: audit.factual_sentences_excluding_disclosures,
    uncited_factual: audit.uncited_factual_sentences.map((s) => ({
      sentence: s.sentence.slice(0, 200),
      best_support: s.best_support,
      is_absence_disclosure: s.is_absence_disclosure,
    })),
    // Readability is the cost side of this change, so it is measured rather
    // than asserted either way.
    words: result.answer.trim().split(/\s+/).length,
    markers: (result.answer.match(/\[\d+(?:\s*,\s*\d+)*\]/g) ?? []).length,
    absence_sentences: (validation.stripped_for_absence ?? []).length + audit.uncited_factual_sentences.filter((s) => isClaimAboutEvidence(s.sentence)).length,
  };
}

export function summariseVariant(rows) {
  const ok = rows.filter((r) => r && !r.error);
  const sum = (f) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
  const cited = sum((r) => r.cited_sentences);
  const factual = sum((r) => r.factual_sentences);
  const factualNet = sum((r) => r.factual_sentences_excluding_disclosures);
  const each = ok.map((r) => r.groundedness).filter((g) => typeof g === 'number');

  return {
    answers: ok.length,
    pooled_grounding: cited ? sum((r) => r.supported_sentences) / cited : null,
    mean_run_grounding: each.length ? each.reduce((a, b) => a + b, 0) / each.length : null,
    completeness: factual ? sum((r) => r.factual_sentences_cited) / factual : null,
    completeness_excluding_disclosures: factualNet ? sum((r) => r.factual_sentences_cited) / factualNet : null,
    cited_sentences: cited,
    supported_sentences: sum((r) => r.supported_sentences),
    // The guard rail. Completeness bought with these is not an improvement.
    unsupported_citations: sum((r) => r.unsupported_citations.length),
    orphan_citations: sum((r) => r.orphan_citations),
    factual_sentences: factual,
    uncited_factual: sum((r) => r.uncited_factual.length),
    uncited_but_supported: sum((r) => r.uncited_factual.filter((s) => !s.is_absence_disclosure && (s.best_support ?? 0) >= 0.5).length),
    words: sum((r) => r.words),
    markers: sum((r) => r.markers),
    output_tokens: sum((r) => r.usage?.output_tokens),
    cost_usd: sum((r) => r.cost_usd),
    latency_ms: ok.length ? Math.round(sum((r) => r.latency_ms) / ok.length) : null,
  };
}

const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const delta = (a, b, d = 3) => {
  if (a === null || b === null || a === undefined || b === undefined) return '—';
  const diff = b - a;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(d)}`;
};

export function render(report) {
  const a = report.variants.legacy;
  const b = report.variants.granular;
  const L = [];
  const A = (line = '') => L.push(line);

  A('# Citation contract, A/B on fixed evidence\n');
  A('> Not a benchmark. Twenty questions, one answer per variant, on evidence');
  A('> replayed from the e2e0e46 run so retrieval cannot vary between them.\n');
  A(`- evidence from: \`${report.commit}\` (${report.ran_at})`);
  A(`- ran: ${report.ab_ran_at}`);
  A(`- model: ${report.model}`);
  A(`- questions: ${report.questions}, ${report.repeats ?? 1} sample(s) per variant each`);
  A(`- answers generated: ${report.questions * (report.repeats ?? 1) * 2}\n`);

  A('## The three dimensions\n');
  A('| measure | A: legacy prompt | B: granularity contract | change |');
  A('|---|---:|---:|---:|');
  A(`| pooled citation grounding | ${fmt(a.pooled_grounding)} | ${fmt(b.pooled_grounding)} | ${delta(a.pooled_grounding, b.pooled_grounding)} |`);
  A(`| mean run grounding | ${fmt(a.mean_run_grounding)} | ${fmt(b.mean_run_grounding)} | ${delta(a.mean_run_grounding, b.mean_run_grounding)} |`);
  A(`| citation completeness | ${fmt(a.completeness)} | ${fmt(b.completeness)} | ${delta(a.completeness, b.completeness)} |`);
  A(
    `| completeness, disclosures excluded | ${fmt(a.completeness_excluding_disclosures)} | ${fmt(b.completeness_excluding_disclosures)} | ` +
      `${delta(a.completeness_excluding_disclosures, b.completeness_excluding_disclosures)} |`,
  );
  A('');

  A('## The guard rail\n');
  A('A prompt demanding a citation per sentence can satisfy completeness by');
  A('citing sentences the block does not support. If this row rises, the change');
  A('is not an improvement whatever else moved.\n');
  A('| | A | B | change |');
  A('|---|---:|---:|---:|');
  A(`| unsupported cited sentences | ${a.unsupported_citations} | ${b.unsupported_citations} | ${delta(a.unsupported_citations, b.unsupported_citations, 0)} |`);
  A(`| orphan citations | ${a.orphan_citations} | ${b.orphan_citations} | ${delta(a.orphan_citations, b.orphan_citations, 0)} |`);
  A(`| uncited factual sentences a source supports | ${a.uncited_but_supported} | ${b.uncited_but_supported} | ${delta(a.uncited_but_supported, b.uncited_but_supported, 0)} |`);
  A('');

  A('## What it costs\n');
  A('| | A | B | change |');
  A('|---|---:|---:|---:|');
  A(`| output tokens | ${a.output_tokens ?? '—'} | ${b.output_tokens ?? '—'} | ${delta(a.output_tokens, b.output_tokens, 0)} |`);
  A(`| cost (USD, synthesis only) | ${fmt(a.cost_usd, 4)} | ${fmt(b.cost_usd, 4)} | ${delta(a.cost_usd, b.cost_usd, 4)} |`);
  A(`| words written | ${a.words} | ${b.words} | ${delta(a.words, b.words, 0)} |`);
  A(`| citation markers | ${a.markers} | ${b.markers} | ${delta(a.markers, b.markers, 0)} |`);
  A(`| markers per 100 words | ${fmt((a.markers / a.words) * 100, 1)} | ${fmt((b.markers / b.words) * 100, 1)} | — |`);
  A(`| mean synthesis latency (ms) | ${a.latency_ms ?? '—'} | ${b.latency_ms ?? '—'} | ${delta(a.latency_ms, b.latency_ms, 0)} |`);
  A('');
  A('Marker density is the readability cost. It is reported, not judged: whether');
  A('a citation on every factual sentence reads well is a call for a person.\n');

  if (report.by_repeat?.length > 1) {
    A('## Each repeat on its own\n');
    A('A gap between the variants that is smaller than the gap between samples of');
    A('the same variant is not a result. One run of each could never show that.\n');
    A('| repeat | completeness A | completeness B | grounding A | grounding B | unsupported A | unsupported B |');
    A('|---|---:|---:|---:|---:|---:|---:|');
    for (const r of report.by_repeat) {
      A(
        `| ${r.repeat} | ${fmt(r.legacy.completeness)} | ${fmt(r.granular.completeness)} | ${fmt(r.legacy.pooled_grounding)} | ` +
          `${fmt(r.granular.pooled_grounding)} | ${r.legacy.unsupported_citations} | ${r.granular.unsupported_citations} |`,
      );
    }
    A('');
  }

  A('## Per question\n');
  A('First sample of each variant.\n');
  A('| question | grounding A→B | completeness A→B | unsupported A→B |');
  A('|---|---|---|---|');
  for (const row of report.runs) {
    const x = row.legacy;
    const y = row.granular;
    if (!x || !y) {
      A(`| ${row.query.slice(0, 44)} | — | — | ${row.error ?? 'missing'} |`);
      continue;
    }
    const comp = (r) => (r.factual_sentences ? (r.factual_sentences_cited / r.factual_sentences).toFixed(2) : '—');
    A(
      `| ${row.query.slice(0, 44)} | ${fmt(x.groundedness, 2)} → ${fmt(y.groundedness, 2)} | ${comp(x)} → ${comp(y)} | ` +
        `${x.unsupported_citations.length} → ${y.unsupported_citations.length} |`,
    );
  }
  return `${L.join('\n')}\n`;
}

async function main() {
  const runPath = flag('run', `${OUT}/grounding-diagnostic.json`);
  const limit = Number(flag('limit', '20'));
  const repeats = Number(flag('repeats', '3'));
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const model = config.llm.quickModel;

  // One at a time, for the same reason the diagnostic takes a lock: several
  // copies writing one report produced a file describing no single run.
  const lock = acquireLock(OUT, { name: '.prompt-ab.lock' });
  const runs = [];
  try {
    for (const record of (run.runs ?? []).filter((r) => !r.error).slice(0, limit)) {
      process.stderr.write(`  ${record.query.slice(0, 54)}`);
      const row = { query: record.query, samples: { legacy: [], granular: [] } };
      // Interleaved rather than all of A then all of B. A provider that
      // degrades partway through a long run would otherwise land entirely on
      // one variant and look like an effect of the prompt.
      for (let i = 0; i < repeats; i += 1) {
        for (const variant of VARIANTS) {
          // A fresh ledger per sample: validate() is pure, but sharing one
          // across calls would let one answer's state reach the next, and the
          // whole point is that only the prompt differs.
          const { ledger, missing } = rebuildLedger(record);
          if (missing.length) {
            row.error = `evidence for source(s) ${missing.join(', ')} was never saved`;
            break;
          }
          try {
            row.samples[variant.key].push(await synthesiseOnce({ query: record.query, ledger, contract: variant.contract, model }));
            process.stderr.write('.');
          } catch (err) {
            row.error = `${variant.key}: ${err.message}`;
            break;
          }
        }
        if (row.error) break;
      }
      process.stderr.write('\n');
      // The first sample of each variant, for the per-question table. The
      // aggregate below uses every sample.
      row.legacy = row.samples.legacy[0] ?? null;
      row.granular = row.samples.granular[0] ?? null;
      runs.push(row);
    }
  } finally {
    lock.release();
  }

  const report = {
    _LIMITATIONS: [
      'Not the official benchmark. One answer per variant per question, n=1.',
      'Evidence is replayed from the e2e0e46 run, so this says nothing about retrieval.',
      'Answers are generated live, so the model is the only source of variance between A and B.',
    ],
    commit: run.commit,
    ran_at: run.ran_at,
    ab_ran_at: new Date().toISOString(),
    model,
    questions: runs.length,
    repeats,
    variants: {
      legacy: summariseVariant(runs.flatMap((r) => r.samples?.legacy ?? [])),
      granular: summariseVariant(runs.flatMap((r) => r.samples?.granular ?? [])),
    },
    // Each repeat summarised on its own, so a reader can see whether the gap
    // between the variants is larger than the gap between samples of the same
    // variant. A difference smaller than its own sampling spread is not a
    // result, and one run of each could never show that.
    by_repeat: Array.from({ length: repeats }, (_, i) => ({
      repeat: i + 1,
      legacy: summariseVariant(runs.map((r) => r.samples?.legacy?.[i]).filter(Boolean)),
      granular: summariseVariant(runs.map((r) => r.samples?.granular?.[i]).filter(Boolean)),
    })),
    runs,
  };

  fs.writeFileSync(path.join(OUT, 'prompt-ab.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'prompt-ab.md'), render(report));
  console.log(`\nwrote ${OUT}/prompt-ab.json and .md`);
  console.log(
    `completeness ${fmt(report.variants.legacy.completeness)} -> ${fmt(report.variants.granular.completeness)}, ` +
      `grounding ${fmt(report.variants.legacy.pooled_grounding)} -> ${fmt(report.variants.granular.pooled_grounding)}, ` +
      `unsupported ${report.variants.legacy.unsupported_citations} -> ${report.variants.granular.unsupported_citations}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
