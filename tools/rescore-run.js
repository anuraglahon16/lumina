#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceLedger, isClaimAboutEvidence, locateSentences } from '../src/agent/core/evidence.js';
import { classifyRetrieval, RETRIEVAL_OUTCOME } from '../src/agent/core/funnel.js';

/**
 * Re-score a finished run against the corrected citation validator.
 *
 * A scoring defect found after a run leaves two options. Re-ask the twenty
 * questions, which costs money, takes a different sample of a web that has
 * moved, and confounds the validator change with everything else that changed
 * between the two runs. Or re-score what was already recorded, which isolates
 * the change to the one thing that changed.
 *
 * The e2e0e46 run reported 0.950 grounding. Seven of its 101 cited sentences
 * were bare "[1]" fragments split off from the claims they cite: counted as
 * cited, counted as supported without any check, and — because the free-support
 * branch returned early — recorded nowhere. Deleting them gives 0.947, but that
 * is a sensitivity calculation, not a corrected score: once each marker is put
 * back on its claim, the claim has to be scored against its source, and some of
 * those will fail. Only re-running the validator says what the number is.
 *
 * Every source is rebuilt from the passages the run saved, through the ledger's
 * own `restoreWebSource`, so the term sets are the ones the original scoring
 * used rather than a tool's approximation of them.
 *
 * It opens no socket and calls no model. `--verify-offline` stubs `fetch` to
 * throw, so that is enforced rather than asserted.
 *
 *   node tools/rescore-run.js --run reports/grounding-diagnostic.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

/**
 * Every passage this run recorded for each source number.
 *
 * Two places hold them and neither alone is enough. `sentence_results[].
 * scored_against` carries the passages for sources that had a scored sentence —
 * but the runs damaged by the defect are exactly the ones whose sentences were
 * never recorded, so for those it is empty. The funnel's usable fetch events
 * carry `extracted_passages` for every page that was read, cited or not, which
 * covers them; it is keyed by url rather than source number, so the run's own
 * source list joins the two.
 */
export function passagesBySource(run) {
  const byN = new Map();

  for (const decision of run.sentence_results ?? []) {
    for (const scored of decision.scored_against ?? []) {
      if (scored?.passages?.length && !byN.has(scored.n)) byN.set(scored.n, scored.passages);
    }
  }

  const byUrl = new Map();
  for (const event of run.funnel?.fetch_events ?? []) {
    if (event.status === 'usable' && event.extracted_passages?.length && !byUrl.has(event.url)) {
      byUrl.set(event.url, event.extracted_passages);
    }
  }
  for (const source of run.sources ?? []) {
    if (byN.has(source.n)) continue;
    const passages = byUrl.get(source.url);
    if (passages) byN.set(source.n, passages);
  }

  return byN;
}

/** The ledger the run had, as far as what was saved can reconstruct it. */
export function rebuildLedger(run) {
  const passages = passagesBySource(run);
  const ledger = new EvidenceLedger();
  const missing = [];
  for (const source of run.sources ?? []) {
    const text = passages.get(source.n);
    if (!text) {
      missing.push(source.n);
      continue;
    }
    ledger.restoreWebSource({ n: source.n, url: source.url, title: source.title, passages: text, snippet: source.snippet ?? '' });
  }
  return { ledger, missing };
}

/**
 * What changed for one run, and whether the rescore can be trusted for it.
 *
 * A source whose passages were never saved cannot be rebuilt, and a sentence
 * citing it would score zero against a ledger that does not contain it — which
 * would read as a citation failure caused by the rescorer. Those runs are
 * reported as `not_rescorable` rather than given a number.
 */
export function rescoreRun(run) {
  if (run.error) return { query: run.query, status: 'errored', error: run.error };
  const { ledger, missing } = rebuildLedger(run);
  if (missing.length) {
    return {
      query: run.query,
      status: 'not_rescorable',
      reason: `no saved passages for source(s) ${missing.join(', ')}; a sentence citing them would score zero against a ledger that lacks them`,
      before: { cited: run.cited_sentences, supported: run.supported_sentences, groundedness: run.groundedness },
    };
  }

  const result = ledger.validate(run.answer);
  return {
    query: run.query,
    status: 'rescored',
    before: {
      cited: run.cited_sentences ?? 0,
      supported: run.supported_sentences ?? 0,
      groundedness: run.groundedness ?? null,
      recorded_decisions: (run.sentence_results ?? []).length,
    },
    after: {
      cited: result.cited_sentences,
      supported: result.supported_sentences,
      groundedness: result.groundedness,
      recorded_decisions: result.sentence_results.length,
      orphan_citations: result.orphan_citations.length,
      unscoreable_citations: result.unscoreable_citations.length,
    },
    // The sentences that changed verdict, since a total that moved without any
    // sentence moving would mean the rescorer, not the validator, did the work.
    newly_unsupported: result.sentence_results
      .filter((s) => !s.supported)
      .map((s) => ({ sentence: s.sentence.slice(0, 200), refs: s.refs, best_score: s.best_score })),
    sentence_results: result.sentence_results,
    factual: factualAudit(run.answer, result, ledger),
  };
}

/**
 * Factual sentences and what happened to their citations.
 *
 * Completeness was 0.571 on the run, and the largest single question about it
 * is how much of the gap is real. A claim whose marker was split off counted as
 * uncited for a reason that has nothing to do with the answer's behaviour, so
 * the count has to be taken again after the split is fixed — and what remains
 * uncited has to be preserved for a person to classify, not summarised away.
 */
export function factualAudit(answer, validation, ledger = null) {
  const sentences = locateSentences(answer ?? '');
  const cited = new Set((validation.sentence_results ?? []).map((s) => s.sentence.slice(0, 120)));
  const stripped = new Set((validation.stripped_for_absence ?? []).map((s) => s.sentence.slice(0, 120)));

  const factual = sentences.filter((s) => {
    if (s.orphan) return false;
    const bare = s.text.replace(/\[[\d,\s]+\]/g, '').trim();
    if (bare.split(/\s+/).length < 6) return false;
    return !/^\*?_?(?:research was cut short|the answer was cut short)/i.test(bare);
  });

  const uncited = factual
    .filter((s) => !/\[\d/.test(s.text))
    .map((s) => ({
      sentence: s.text.slice(0, 400),
      // Two signals a person should not have to work out by hand, and that a
      // tool can get exactly right.
      //
      // `best_support` is the validator's own measurement, applied to a
      // sentence nobody cited: it separates "the answer had evidence for this
      // and did not cite it" from "the answer asserted something nothing here
      // supports", which are different problems with different fixes.
      //
      // `is_absence_disclosure` matters more than it looks. The synthesis
      // prompt *requires* these to be uncited — citing a page for the absence
      // of a fact points at a page that cannot support the claim. Counting them
      // as uncited factual sentences marks the answer down for obeying its
      // instructions, so the denominator has to be able to exclude them.
      best_support: ledger ? ledger.scoreSentence(s.text) : null,
      is_absence_disclosure: isClaimAboutEvidence(s.text),
      // The judgement itself is left to a person: whether a sentence asserts
      // something checkable is not something an overlap score decides.
      category: null,
    }));

  const disclosures = uncited.filter((s) => s.is_absence_disclosure).length;
  return {
    factual_sentences: factual.length,
    factual_sentences_cited: factual.filter((s) => /\[\d/.test(s.text)).length,
    // The denominator with the sentences the prompt requires to be uncited
    // taken out of it. Reported alongside the raw count, never instead of it.
    factual_sentences_excluding_disclosures: factual.length - disclosures,
    uncited_absence_disclosures: disclosures,
    absence_disclosures_stripped: [...stripped].length,
    cited_decisions: cited.size,
    uncited_factual_sentences: uncited,
  };
}

/** The three dimensions over the rescored runs. */
export function summarise(rescored) {
  const ok = rescored.filter((r) => r.status === 'rescored');
  const sum = (f) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);

  // Kept at full precision and rounded once, at render. Rounding here and
  // again there turns 96/101 = 0.9505 into "0.951", which does not match the
  // 0.950 the same figure was first published as — a discrepancy that reads as
  // a real change when it is only arithmetic done twice.
  const pooled = (key) => {
    const cited = sum((r) => r[key].cited);
    return cited ? sum((r) => r[key].supported) / cited : null;
  };
  const meanOf = (key) => {
    const each = ok.map((r) => r[key].groundedness).filter((g) => typeof g === 'number');
    return each.length ? each.reduce((a, b) => a + b, 0) / each.length : null;
  };
  const factualTotal = sum((r) => r.factual.factual_sentences);
  const factualNetTotal = sum((r) => r.factual.factual_sentences_excluding_disclosures);

  return {
    runs: rescored.length,
    rescored: ok.length,
    not_rescorable: rescored.filter((r) => r.status === 'not_rescorable').length,
    errored: rescored.filter((r) => r.status === 'errored').length,
    pooled_grounding: { before: pooled('before'), after: pooled('after') },
    mean_run_grounding: { before: meanOf('before'), after: meanOf('after') },
    cited_sentences: { before: sum((r) => r.before.cited), after: sum((r) => r.after.cited) },
    supported_sentences: { before: sum((r) => r.before.supported), after: sum((r) => r.after.supported) },
    orphan_citations: sum((r) => r.after.orphan_citations),
    unscoreable_citations: sum((r) => r.after.unscoreable_citations),
    completeness: {
      after: factualTotal ? sum((r) => r.factual.factual_sentences_cited) / factualTotal : null,
      factual_sentences: factualTotal,
      factual_sentences_cited: sum((r) => r.factual.factual_sentences_cited),
      uncited_awaiting_classification: sum((r) => r.factual.uncited_factual_sentences.length),
      excluding_required_disclosures: factualNetTotal ? sum((r) => r.factual.factual_sentences_cited) / factualNetTotal : null,
      factual_sentences_excluding_disclosures: factualNetTotal,
      uncited_absence_disclosures: sum((r) => r.factual.uncited_absence_disclosures),
      uncited_supported_anyway: sum(
        (r) => r.factual.uncited_factual_sentences.filter((s) => !s.is_absence_disclosure && (s.best_support ?? 0) >= 0.5).length,
      ),
      uncited_unsupported: sum(
        (r) => r.factual.uncited_factual_sentences.filter((s) => !s.is_absence_disclosure && (s.best_support ?? 0) < 0.5).length,
      ),
    },
  };
}

/**
 * Retrieval outcomes recomputed, since three of them turned on citation counts.
 *
 * `citation_failure` is decided by cited and supported sentence totals, so any
 * run whose totals moved may move category. Runs without a relevance annotation
 * stay `pending_review`, exactly as before.
 */
export function reclassify(reviewed, rescored) {
  const byQuery = new Map(rescored.map((r) => [r.query, r]));
  const runs = (reviewed?.runs ?? []).map((r) => {
    if (r.error) return r;
    const fresh = byQuery.get(r.query);
    if (!fresh || fresh.status !== 'rescored') return { ...r, retrieval_outcome_rescored: null };
    const funnel = r.funnel
      ? {
          candidates: (r.funnel.searches ?? []).flatMap((s) => s.results.map((x) => ({ ...x, search_attempt: s.attempt }))),
          fetch_events: r.funnel.fetch_events ?? [],
          stop_reason: r.funnel.stop_reason ?? null,
        }
      : null;
    return {
      ...r,
      retrieval_outcome_rescored: classifyRetrieval(funnel, {
        citedSentences: fresh.after.cited,
        supportedSentences: fresh.after.supported,
        review: r.review && Array.isArray(r.review.relevant_urls) ? r.review : null,
      }),
    };
  });
  return runs;
}

export function render(report) {
  const s = report.summary;
  const L = [];
  const A = (line = '') => L.push(line);

  A('# Rescored offline against the corrected citation validator\n');
  A(`- run: \`${report.commit}\` at ${report.ran_at}`);
  A(`- rescored: ${report.rescored_at}`);
  A(`- questions: ${s.runs} (${s.rescored} rescored, ${s.not_rescorable} not rescorable, ${s.errored} errored)`);
  A('- no network or model call: this reads the saved run and nothing else\n');

  A('## What the fix changed\n');
  A('| measure | as first reported | rescored |');
  A('|---|---:|---:|');
  A(`| pooled citation grounding | ${fmt(s.pooled_grounding.before)} | **${fmt(s.pooled_grounding.after)}** |`);
  A(`| mean run grounding | ${fmt(s.mean_run_grounding.before)} | **${fmt(s.mean_run_grounding.after)}** |`);
  A(`| cited sentences | ${s.cited_sentences.before} | ${s.cited_sentences.after} |`);
  A(`| supported sentences | ${s.supported_sentences.before} | ${s.supported_sentences.after} |`);
  A('');
  A(`Orphan citations, counted in neither direction: ${s.orphan_citations}.`);
  A(`Cited sentences with nothing checkable in them, also counted in neither: ${s.unscoreable_citations}.\n`);

  A('## Citation completeness\n');
  A(`- cited factual sentences: ${s.completeness.factual_sentences_cited} of ${s.completeness.factual_sentences} = **${fmt(s.completeness.after)}**`);
  A(
    `- excluding the disclosures the prompt requires to be uncited: ${s.completeness.factual_sentences_cited} of ` +
      `${s.completeness.factual_sentences_excluding_disclosures} = **${fmt(s.completeness.excluding_required_disclosures)}**`,
  );
  A('');
  A('Of the uncited factual sentences, measured rather than judged:\n');
  A('| | sentences |');
  A('|---|---:|');
  A(`| statements a source in the same run supports (>= 0.5 overlap) | ${s.completeness.uncited_supported_anyway} |`);
  A(`| statements no source supports | ${s.completeness.uncited_unsupported} |`);
  A(`| disclosures about what the evidence lacks, required to be uncited | ${s.completeness.uncited_absence_disclosures} |`);
  A(`| **total awaiting classification** | **${s.completeness.uncited_awaiting_classification}** |`);
  A('');
  A('The split above is the validator\'s own overlap measure applied to sentences');
  A('nobody cited. It separates an answer that had evidence and did not cite it');
  A('from one that asserted something nothing supports. It does not decide');
  A('whether a sentence asserts anything checkable — that judgement is left in');
  A('reports/uncited-audit.json for a person.\n');

  A('## Retrieval outcomes, recomputed\n');
  A('| outcome | runs |');
  A('|---|---:|');
  for (const [k, v] of Object.entries(report.outcomes).sort((a, b) => b[1] - a[1])) A(`| ${k} | ${v} |`);
  A('');

  A('## Per question\n');
  A('| question | cited → | supported → | grounding → | outcome |');
  A('|---|---|---|---|---|');
  for (const r of report.runs) {
    if (r.status !== 'rescored') {
      A(`| ${r.query.slice(0, 44)} | — | — | — | ${r.status} |`);
      continue;
    }
    A(
      `| ${r.query.slice(0, 44)} | ${r.before.cited} → ${r.after.cited} | ${r.before.supported} → ${r.after.supported} | ` +
        `${fmt(r.before.groundedness)} → ${fmt(r.after.groundedness)} | ${r.outcome ?? '—'} |`,
    );
  }
  return `${L.join('\n')}\n`;
}

const fmt = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(3));

export function rescore(run, reviewed = null) {
  const rescored = (run.runs ?? []).map(rescoreRun);
  const reclassified = reviewed ? reclassify(reviewed, rescored) : [];
  const byQuery = new Map(reclassified.map((r) => [r.query, r.retrieval_outcome_rescored?.primary ?? null]));

  const outcomes = {};
  for (const r of reclassified) {
    const key = r.retrieval_outcome_rescored?.primary ?? RETRIEVAL_OUTCOME.PENDING_REVIEW;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  const runs = rescored.map((r) => ({ ...r, outcome: byQuery.get(r.query) ?? null }));
  return {
    commit: run.commit,
    ran_at: run.ran_at,
    rescored_at: new Date().toISOString(),
    health: run.health ?? null,
    summary: summarise(rescored),
    outcomes,
    runs,
  };
}

function main() {
  const runPath = flag('run', 'reports/grounding-diagnostic.json');
  const reviewedPath = flag('reviewed', 'reports/retrieval-outcomes.json');

  if (has('verify-offline')) {
    // Enforced rather than asserted: if anything in this path reaches the
    // network, it fails loudly here instead of quietly producing numbers that
    // came from somewhere other than the saved run.
    globalThis.fetch = () => {
      throw new Error('rescoring must not reach the network');
    };
  }

  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const reviewed = fs.existsSync(reviewedPath) ? JSON.parse(fs.readFileSync(reviewedPath, 'utf8')) : null;
  const report = rescore(run, reviewed);

  const dir = path.dirname(runPath);
  fs.writeFileSync(path.join(dir, 'rescored.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'rescored.md'), render(report));

  // The uncited factual sentences, as a file a person fills in.
  const audit = {
    _README: [
      'One entry per factual sentence that carries no citation. Classify each:',
      'placement_artifact        — the claim is cited, the marker sits where the parser could not attach it',
      'evidence_supported_uncited— a source in this run supports it and the answer did not cite it',
      'unsupported_statement     — nothing in this run supports it',
      'transition_or_non_factual — it asserts nothing checkable',
      'evidence_gap_disclosure   — it describes what the evidence does not say',
      'splitter_artifact         — it is not a sentence; the splitter made it',
      'Leave category null to say you have not decided.',
    ],
    commit: report.commit,
    ran_at: report.ran_at,
    questions: report.runs
      .filter((r) => r.status === 'rescored' && r.factual.uncited_factual_sentences.length)
      .map((r) => ({ question: r.query, sentences: r.factual.uncited_factual_sentences })),
  };
  const auditPath = path.join(dir, 'uncited-audit.json');
  if (!fs.existsSync(auditPath)) fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);

  console.log(`wrote ${dir}/rescored.json, .md and ${fs.existsSync(auditPath) ? 'uncited-audit.json' : ''}`);
  console.log(
    `pooled grounding ${fmt(report.summary.pooled_grounding.before)} -> ${fmt(report.summary.pooled_grounding.after)}, ` +
      `mean ${fmt(report.summary.mean_run_grounding.before)} -> ${fmt(report.summary.mean_run_grounding.after)}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
