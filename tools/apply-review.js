#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { classifyRetrieval, RETRIEVAL_OUTCOME } from '../src/agent/core/funnel.js';

/**
 * A run's identity, so a review cannot be applied to a different one.
 *
 * Two runs at the same commit ask the same questions and get different pages,
 * because the web moved. A review naming urls from the first, applied to the
 * second, produces categories that look considered and describe nothing —
 * relevant_urls that are not in the results at all read as query_miss, and a
 * run that went perfectly well is recorded as a search failure.
 *
 * The questions are included in order, since a review is keyed by question, and
 * `ran_at` because that is what separates two runs of the same set.
 */
export function fingerprint(run) {
  const material = JSON.stringify({
    commit: run.commit ?? null,
    ran_at: run.ran_at ?? null,
    questions: (run.runs ?? []).map((r) => r.query ?? null),
  });
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/**
 * Turn a recorded run into retrieval outcomes, after a person has read it.
 *
 * The run records what happened. It cannot record whether a result was the one
 * that would have answered the question, or whether the answer addressed what
 * was asked — both are judgements, and the lexical score available during a run
 * is a weak proxy for the first and no proxy at all for the second.
 *
 * Guessing them is not a small inaccuracy. A search that returns pages about
 * something else, followed by an answer that honestly declines to use them,
 * records identically to an answer ignoring perfectly good evidence. One is a
 * query problem and the other a synthesis problem, and acting on the wrong one
 * means rewriting the part that behaved correctly.
 *
 * So the run leaves every outcome `pending_review` and this applies the
 * annotations afterwards. It reads two files and writes two; it opens no
 * network connection and calls no model, which is what makes it repeatable and
 * what keeps "one clean run" meaning one run.
 *
 *   node tools/apply-review.js --run reports/grounding-diagnostic.json \
 *                             --review reports/retrieval-review.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/**
 * A blank review, one entry per question, for a person to fill in.
 *
 * Generated from the run rather than written by hand so the questions and the
 * candidate lists are exactly the ones that were seen, and a reviewer is
 * choosing among real urls rather than recalling them.
 */
export function reviewTemplate(run) {
  return {
    _README: [
      'One entry per question. Fill these in by reading the funnel in the run file.',
      'relevant_urls: the results that could have answered the question. Judgement, not a score.',
      'extracted_passages_contain_answer: did the text actually extracted carry the answer?',
      'answer_addressed_question: did the answer address what was asked, whatever its citations say?',
      'answer_complete: did it cover the question, or only part of it?',
      'Leave a field null to say you have not decided; the outcome stays pending_review.',
      'Each field is asked for only once the run reached the stage that needs it.',
    ],
    run_fingerprint: fingerprint(run),
    commit: run.commit,
    ran_at: run.ran_at,
    questions: (run.runs ?? [])
      .filter((r) => !r.error)
      .map((r) => ({
        question: r.query,
        candidates: (r.funnel?.searches ?? []).flatMap((s) =>
          s.results.map((x) => ({ search_attempt: s.attempt, rank: x.rank, url: x.url, title: x.title })),
        ),
        relevant_urls: null,
        extracted_passages_contain_answer: null,
        answer_addressed_question: null,
        answer_complete: null,
        notes: '',
      })),
  };
}

/** Apply a review to a run, producing one primary outcome per question. */
export function applyReview(run, review) {
  const expected = fingerprint(run);
  if (!review.run_fingerprint) {
    throw new Error('this review carries no run_fingerprint, so there is no way to tell which run it describes');
  }
  if (review.run_fingerprint !== expected) {
    throw new Error(
      `this review belongs to a different run (${review.run_fingerprint} against ${expected}). ` +
        'Two runs of the same questions at the same commit read different pages, so a review of one says nothing true about the other.',
    );
  }

  const byQuestion = new Map((review.questions ?? []).map((q) => [q.question, q]));

  const runs = (run.runs ?? []).map((r) => {
    if (r.error) return r;
    const annotation = byQuestion.get(r.query) ?? null;
    const funnel = r.funnel
      ? {
          candidates: (r.funnel.searches ?? []).flatMap((s) => s.results.map((x) => ({ ...x, search_attempt: s.attempt }))),
          fetch_events: r.funnel.fetch_events ?? [],
          // Why the pool stopped. Without it a coverage_miss — relevant pages
          // cancelled because a partial page satisfied coverage — is
          // indistinguishable from an extraction failure on the page that did
          // get read, and the two want opposite repairs.
          stop_reason: r.funnel.stop_reason ?? null,
        }
      : null;

    const outcome = classifyRetrieval(funnel, {
      citedSentences: r.cited_sentences ?? 0,
      supportedSentences: r.supported_sentences ?? 0,
      review: annotation && Array.isArray(annotation.relevant_urls) ? annotation : null,
    });

    return { ...r, retrieval_outcome: outcome, review: annotation ? { ...annotation, candidates: undefined } : null };
  });

  return { ...run, reviewed_at: new Date().toISOString(), runs };
}

/** The three dimensions, each measured on its own terms. */
export function summarise(run) {
  const ok = (run.runs ?? []).filter((r) => !r.error);
  const sum = (f) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);

  const citedTotal = sum((r) => r.cited_sentences);
  const grounding = citedTotal ? sum((r) => r.supported_sentences) / citedTotal : null;
  const perRun = ok.map((r) => r.groundedness).filter((g) => typeof g === 'number');
  const meanRun = perRun.length ? perRun.reduce((a, b) => a + b, 0) / perRun.length : null;
  const factualTotal = sum((r) => r.factual_sentences);
  const completeness = factualTotal ? sum((r) => r.factual_sentences_cited) / factualTotal : null;

  const outcomes = {};
  for (const r of ok) {
    const key = r.retrieval_outcome?.primary ?? RETRIEVAL_OUTCOME.PENDING_REVIEW;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  return { runs: ok.length, grounding, meanRun, completeness, outcomes };
}

export function render(run) {
  const s = summarise(run);
  const L = [];
  const A = (line = '') => L.push(line);

  A('# Retrieval outcomes, after review\n');
  // Emitted by the generator rather than added to the file afterwards. A note
  // written by hand into generated output survives until the next run of the
  // generator, which is exactly when someone is most likely to read the file
  // and least likely to remember the caveat.
  A('> **Not the official benchmark.** One observational run, n=1 per question.');
  A('> Citation figures here are superseded by `rescored.md`: a sentence-splitter');
  A('> defect split claims from their citation markers. Outcomes derived from');
  A('> citation counts are provisional, and `agent_direct_ttft_ms` is not the gate');
  A('> metric. See `README.md` in this directory.\n');
  A(`- commit: \`${run.commit}\``);
  A(`- run: ${run.ran_at}`);
  A(`- reviewed: ${run.reviewed_at ?? 'not yet'}`);
  A(`- questions: ${s.runs}\n`);

  A('## Three dimensions, measured separately\n');
  A('| dimension | value | what it does not tell you |');
  A('|---|---:|---|');
  A(
    `| citation grounding (supported ÷ cited sentences) | ${s.grounding === null ? '—' : s.grounding.toFixed(3)} | whether the question was answered |`,
  );
  A(`| mean run grounding | ${s.meanRun === null ? '—' : s.meanRun.toFixed(3)} | the same, weighted per run rather than per sentence |`);
  A(
    `| citation completeness (cited ÷ factual sentences) | ${s.completeness === null ? '—' : s.completeness.toFixed(3)} | whether the cited ones were right |`,
  );
  A('');
  A('A system can score 1.00 on grounding by citing one safe sentence and');
  A('leaving the rest uncited, and can cite everything perfectly while answering');
  A('a different question from the one asked. Neither number sees the other, and');
  A('neither sees retrieval.\n');

  A('## Where retrieval ended up\n');
  A('| outcome | runs |');
  A('|---|---:|');
  for (const [k, v] of Object.entries(s.outcomes).sort((a, b) => b[1] - a[1])) A(`| ${k} | ${v} |`);
  A(`| **total** | **${s.runs}** |`);
  A('');
  if (s.outcomes[RETRIEVAL_OUTCOME.PENDING_REVIEW]) {
    A(`${s.outcomes[RETRIEVAL_OUTCOME.PENDING_REVIEW]} question(s) have no relevance annotation yet and are deliberately`);
    A('unclassified. They are not a category of failure; they are unreviewed.\n');
  }

  A('## Per question\n');
  A('| question | outcome | cited | supported | factual cited |');
  A('|---|---|---:|---:|---:|');
  for (const r of (run.runs ?? []).filter((x) => !x.error)) {
    A(
      `| ${String(r.query).slice(0, 46)} | ${r.retrieval_outcome?.primary ?? '—'} | ${r.cited_sentences ?? '—'} | ${
        r.supported_sentences ?? '—'
      } | ${r.factual_sentences_cited ?? '—'}/${r.factual_sentences ?? '—'} |`,
    );
  }
  return `${L.join('\n')}\n`;
}

function main() {
  const runPath = flag('run', 'reports/grounding-diagnostic.json');
  const reviewPath = flag('review', 'reports/retrieval-review.json');
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));

  if (!fs.existsSync(reviewPath)) {
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviewTemplate(run), null, 2)}\n`);
    console.log(`No review found. Wrote a blank one to ${reviewPath}; fill it in and run this again.`);
    return;
  }

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const reviewed = applyReview(run, review);
  const dir = path.dirname(runPath);
  fs.writeFileSync(path.join(dir, 'retrieval-outcomes.json'), `${JSON.stringify(reviewed, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'retrieval-outcomes.md'), render(reviewed));
  console.log(`wrote ${dir}/retrieval-outcomes.json and .md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
