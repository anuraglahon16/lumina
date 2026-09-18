#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaimAboutEvidence } from '../src/agent/core/evidence.js';
import { rebuildLedger } from './rescore-run.js';
import { shapeOf } from './classify-misses.js';

/**
 * Build the case file for every sentence the lexical validator called unsupported.
 *
 * A 0.5 content-word overlap cannot tell a paraphrase from a fabrication. It was
 * never meant to: it was chosen as a loose bar that catches a citation pointing
 * at the wrong source, and it is doing that job. What it cannot do is serve as
 * the truth label for whether a sentence is supported, which is exactly what it
 * would be doing if the next design decision were taken from it.
 *
 * So the sentences are not scored again here. They are assembled with
 * everything a person needs to decide — the question, the whole answer around
 * the sentence, every saved passage of every source, and what the validator
 * said — and the decision column is left empty.
 *
 * Two things this deliberately does not do. It does not label. And it does not
 * write into the experiment file: the adjudication lives in its own document,
 * because a human judgement mixed into automated output is one regeneration
 * away from being gone, and afterwards indistinguishable from a machine's.
 *
 *   node tools/adjudicate.js --ab reports/prompt-ab.json --run reports/grounding-diagnostic.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

export const ADJUDICATIONS = [
  'fully_supported_paraphrase',
  'partially_supported',
  'unsupported',
  'overstated_beyond_evidence',
  'evidence_gap_disclosure',
  'non_factual_framing',
  'splitter_artifact',
  'uncertain',
];

/**
 * Every uncited factual sentence no source supports at the lexical bar.
 *
 * These are the ones that bound the metric: they cannot be cited without citing
 * a source that does not support them, so no amount of citation discipline
 * reaches them. Whether that is because they should not have been written or
 * because the bar cannot see paraphrase is the whole question.
 */
export function unsupportedSentences(ab, variant = 'granular') {
  const out = [];
  for (const row of ab.runs ?? []) {
    for (const [i, sample] of (row.samples?.[variant] ?? []).entries()) {
      for (const uncited of sample.uncited_factual ?? []) {
        if (uncited.is_absence_disclosure) continue;
        if ((uncited.best_support ?? 0) >= 0.5) continue;
        out.push({
          question: row.query,
          sample: i + 1,
          sentence: uncited.sentence,
          lexical_score: uncited.best_support,
          answer: sample.answer,
          shape_guess: shapeOf(uncited.sentence),
          // Recorded because the narrow absence patterns miss some disclosures,
          // and a reviewer should see what the machine thought before deciding.
          machine_called_it_a_disclosure: isClaimAboutEvidence(uncited.sentence),
        });
      }
    }
  }
  return out;
}

/** The passages available to the answer, by source, from the saved run. */
export function passagesFor(run, question) {
  const record = (run.runs ?? []).find((r) => r.query === question && !r.error);
  if (!record) return [];
  const { ledger, missing } = rebuildLedger(record);
  if (missing.length) return [];
  return ledger.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, passages: s.passages }));
}

export function build(ab, run, variant = 'granular') {
  const sentences = unsupportedSentences(ab, variant);
  const passageCache = new Map();

  return {
    _README: [
      'Human adjudication of sentences the lexical validator called unsupported.',
      'A 0.5 content-word overlap cannot separate paraphrase from fabrication. These labels decide that; the score does not.',
      '',
      'For each entry set `adjudication` to exactly one of:',
      ...ADJUDICATIONS.map((a) => `  ${a}`),
      '',
      'fully_supported_paraphrase : a saved passage entails the sentence. Name it in `entailing_passage`.',
      'partially_supported        : part of it is in the evidence. Fill `supported_part` and `unsupported_part`.',
      'overstated_beyond_evidence : the evidence says something weaker. Fill both parts.',
      'unsupported                : no saved passage supports it. Say so in `notes`, from the passages only.',
      '                             General knowledge that the claim is true is not support; the question is what this run read.',
      'evidence_gap_disclosure    : it describes what the evidence does or does not cover.',
      'non_factual_framing        : it announces what follows and asserts nothing checkable.',
      'splitter_artifact          : it is not a sentence.',
      'uncertain                  : you could not decide. Left as uncertain, never guessed into a category.',
      '',
      'Leave `adjudication` null until decided. A null is a null, not a quiet "unsupported".',
      'This file is human judgement and no tool writes labels into it.',
    ],
    source_experiment: { ab_ran_at: ab.ab_ran_at, variant, evidence_from: ab.commit },
    built_at: new Date().toISOString(),
    count: sentences.length,
    entries: sentences.map((s, i) => {
      if (!passageCache.has(s.question)) passageCache.set(s.question, passagesFor(run, s.question));
      return {
        id: `u${String(i + 1).padStart(2, '0')}`,
        question: s.question,
        sample: s.sample,
        sentence: s.sentence,
        lexical_score: s.lexical_score,
        machine_shape_guess: s.shape_guess,
        machine_called_it_a_disclosure: s.machine_called_it_a_disclosure,
        // The whole answer, not a window. Whether a sentence is framing or a
        // claim depends on what surrounds it, and a window chosen by a tool is
        // a tool deciding what the reviewer is allowed to see.
        answer_context: s.answer,
        available_passages: passageCache.get(s.question),
        // Filled in by a person.
        adjudication: null,
        entailing_passage: null,
        supported_part: null,
        unsupported_part: null,
        notes: '',
        second_review: null,
      };
    }),
  };
}

/** Counts, rates and the two completeness figures the labels imply. */
export function summarise(adjudication, ab, variant = 'granular') {
  const entries = adjudication.entries ?? [];
  const decided = entries.filter((e) => e.adjudication);
  const counts = {};
  for (const e of decided) counts[e.adjudication] = (counts[e.adjudication] ?? 0) + 1;

  const v = ab.variants[variant];
  const factual = v.factual_sentences;
  const cited = Math.round(v.completeness * factual);
  const uncitedSupported = v.uncited_but_supported;
  // Disclosures the absence patterns already caught. They are as much outside
  // the denominator as the ones adjudication found, and leaving them in
  // understates the corrected figure by exactly their count.
  //
  // Counted from the samples rather than read off the variant summary, which
  // does not carry the figure — and a missing field read through `??` would
  // silently become zero, which is the shape of a correction that quietly
  // fails to correct.
  const detectedDisclosures = (ab.runs ?? []).reduce(
    (a, row) => a + (row.samples?.[variant] ?? []).reduce((b, s) => b + (s.uncited_factual ?? []).filter((u) => u.is_absence_disclosure).length, 0),
    0,
  );

  // A false negative is a sentence the validator called unsupported that a
  // reader finds fully entailed by a passage the run actually read.
  const falseNegatives = counts.fully_supported_paraphrase ?? 0;
  const trulyUnsupported = (counts.unsupported ?? 0) + (counts.overstated_beyond_evidence ?? 0);
  const artifacts = (counts.splitter_artifact ?? 0) + (counts.non_factual_framing ?? 0) + (counts.evidence_gap_disclosure ?? 0);

  return {
    total: entries.length,
    decided: decided.length,
    undecided: entries.length - decided.length,
    counts,
    // Over the adjudicated set only. This is the rate among sentences the
    // validator already flagged, not over all cited sentences: it says how
    // often a flag is wrong, which is a different and smaller question than
    // how often the validator is wrong.
    lexical_false_negative_rate: decided.length ? falseNegatives / decided.length : null,
    true_unsupported_rate: decided.length ? trulyUnsupported / decided.length : null,
    measurement_artifact_rate: decided.length ? artifacts / decided.length : null,
    // Every sentence the contract requires to be uncited: the ones the absence
    // patterns caught during the run, and the ones only a reader caught.
    disclosures: { detected_automatically: detectedDisclosures, found_by_adjudication: counts.evidence_gap_disclosure ?? 0 },
    completeness: {
      measured: v.completeness,
      // The same run, with sentences that are required to carry no citation
      // taken out of the denominator they should never have been in.
      corrected_denominator: factual - detectedDisclosures - artifacts,
      corrected: factual - detectedDisclosures - artifacts ? cited / (factual - detectedDisclosures - artifacts) : null,
      // Everything a source supports gets cited, including the paraphrases the
      // lexical bar could not see.
      ceiling_by_citation_alone:
        factual - detectedDisclosures - artifacts
          ? (cited + uncitedSupported + falseNegatives + (counts.partially_supported ?? 0)) / (factual - detectedDisclosures - artifacts)
          : null,
      // And the sentences nothing supports are not written at all.
      if_unsupported_removed:
        factual - detectedDisclosures - artifacts - trulyUnsupported
          ? (cited + uncitedSupported + falseNegatives + (counts.partially_supported ?? 0)) / (factual - detectedDisclosures - artifacts - trulyUnsupported)
          : null,
    },
  };
}

export function render(adjudication, summary) {
  const L = [];
  const A = (line = '') => L.push(line);

  A('# Adjudication: are the unsupported sentences unsupported?\n');
  A('> Human labels on every sentence the lexical validator called unsupported.');
  A('> The 0.5 overlap score is the thing being checked here, not the authority.\n');
  A(`- from: ${adjudication.source_experiment.ab_ran_at} (${adjudication.source_experiment.variant} arm)`);
  A(`- sentences: ${summary.total}, adjudicated ${summary.decided}, undecided ${summary.undecided}\n`);

  A('## Distribution\n');
  A('| adjudication | sentences | share |');
  A('|---|---:|---:|');
  for (const [k, n] of Object.entries(summary.counts).sort((a, b) => b[1] - a[1])) {
    A(`| ${k} | ${n} | ${((n / summary.decided) * 100).toFixed(0)}% |`);
  }
  A(`| **total adjudicated** | **${summary.decided}** | |`);
  A('');

  A('## What that means for the metric\n');
  A('| | rate |');
  A('|---|---:|');
  A(`| lexical validator false negatives, among sentences it flagged | ${pct(summary.lexical_false_negative_rate)} |`);
  A(`| genuinely unsupported or overstated | ${pct(summary.true_unsupported_rate)} |`);
  A(`| measurement artifacts that should never have been in the denominator | ${pct(summary.measurement_artifact_rate)} |`);
  A('');
  A(`Evidence-gap disclosures found: ${summary.disclosures.detected_automatically} by the absence patterns during the run, `);
  A(`${summary.disclosures.found_by_adjudication} more only by reading. All of them are required by the prompt to carry`);
  A('no citation, and all of them were counted against completeness.\n');
  A('| completeness | value |');
  A('|---|---:|');
  A(`| as measured | ${num(summary.completeness.measured)} |`);
  A(`| corrected, disclosures out of the denominator (${summary.completeness.corrected_denominator} sentences) | **${num(summary.completeness.corrected)}** |`);
  A(`| ceiling from citation attachment alone, artifacts excluded | ${num(summary.completeness.ceiling_by_citation_alone)} |`);
  A(`| if genuinely unsupported sentences were not written | ${num(summary.completeness.if_unsupported_removed)} |`);
  A('');

  const disagreements = (adjudication.entries ?? []).filter((e) => e.second_review && e.second_review.adjudication && e.second_review.adjudication !== e.adjudication);
  const refusals = (adjudication.entries ?? []).filter((e) => typeof e.refusal_accurate === 'boolean');
  if (refusals.length) {
    const bad = refusals.filter((e) => !e.refusal_accurate);
    A('## Are the refusals true?\n');
    A(`${bad.length} of ${refusals.length} evidence-gap disclosures are not true of the evidence the answer had.\n`);
    A('| question | refusal accurate | what the passages actually contain |');
    A('|---|---|---|');
    const seen = new Set();
    for (const e of refusals) {
      if (seen.has(e.question)) continue;
      seen.add(e.question);
      A(`| ${e.question.slice(0, 40)} | ${e.refusal_accurate ? 'yes' : '**no**'} | ${(e.contradicting_passage ?? 'nothing on the topic').slice(0, 110)} |`);
    }
    A('');
    A('A disclosure is only exempt from citation because it reports a real gap.');
    A('One that reports a gap the evidence does not have is not a disclosure at');
    A('all: it is an answer refusing material it was given, and it costs the');
    A('reader the answer they asked for.\n');
  }

  A('## Second review\n');
  const reviewed = (adjudication.entries ?? []).filter((e) => e.second_review?.adjudication);
  A(`${reviewed.length} entr${reviewed.length === 1 ? 'y' : 'ies'} carried a second independent review; ${disagreements.length} disagreed.\n`);
  if (disagreements.length) {
    A('| id | first | second | sentence |');
    A('|---|---|---|---|');
    for (const d of disagreements) {
      A(`| ${d.id} | ${d.adjudication} | ${d.second_review.adjudication} | ${d.sentence.slice(0, 70)} |`);
    }
    A('');
    A('Disagreements are reported, not resolved by picking one. A sentence two');
    A('readings place differently is evidence about the category boundary.\n');
  }

  A('## Every sentence\n');
  for (const [label] of Object.entries(summary.counts).sort((a, b) => b[1] - a[1])) {
    A(`### ${label}\n`);
    for (const e of (adjudication.entries ?? []).filter((x) => x.adjudication === label)) {
      A(`**${e.id}** (lexical ${e.lexical_score}) — ${e.sentence.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (e.entailing_passage) A(`  - entailed by: ${String(e.entailing_passage).replace(/\s+/g, ' ').slice(0, 200)}`);
      if (e.supported_part) A(`  - supported: ${e.supported_part}`);
      if (e.unsupported_part) A(`  - not supported: ${e.unsupported_part}`);
      if (e.notes) A(`  - ${e.notes}`);
      A('');
    }
  }
  return `${L.join('\n')}\n`;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(3));

function main() {
  const abPath = flag('ab', 'reports/prompt-ab.json');
  const runPath = flag('run', 'reports/grounding-diagnostic.json');
  const outPath = flag('out', 'reports/unsupported-adjudication.json');
  const ab = JSON.parse(fs.readFileSync(abPath, 'utf8'));
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));

  if (fs.existsSync(outPath)) {
    // Never rebuilt over an existing one. The labels in it are the work.
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const summary = summarise(existing, ab);
    fs.writeFileSync(outPath.replace(/\.json$/, '.md'), render(existing, summary));
    console.log(`summarised ${summary.decided}/${summary.total} adjudicated`);
    for (const [k, v] of Object.entries(summary.counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    return;
  }

  const dataset = build(ab, run);
  fs.writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`wrote ${outPath} with ${dataset.count} sentences to adjudicate`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
