#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherFromWeb } from '../src/agent/core/retrieve.js';
import { createFunnel, classifyRetrieval } from '../src/agent/core/funnel.js';
import { EvidenceLedger } from '../src/agent/core/evidence.js';
import { Budget } from '../src/agent/core/budget.js';
import { config } from '../src/shared/config.js';
import { acquireLock } from './diagnostic-lock.js';

/**
 * Does retrieval now record what it cancels, and does the HTTP/3 case classify?
 *
 * Two claims were made and neither can be checked against the run that
 * motivated them. Fetch outcomes moved into the promise settlement path, so
 * aborted losers should now be recorded as `cancelled` rather than frozen at
 * `attempted` — but the e2e0e46 run predates the change and has thirty frozen
 * events in it. And `coverage_miss` exists to separate a premature coverage
 * stop from an extraction failure, but deciding it requires a fetch event
 * recorded as cancelled, which that run does not contain. The category was
 * added and could not be exercised on the data that called for it.
 *
 * This runs retrieval only. No synthesis, no model call, no gateway: it
 * searches, fetches, and writes the funnel. That is the whole surface the two
 * claims live on, and leaving synthesis out keeps it cheap enough to re-run and
 * removes the model as a source of variation.
 *
 * It reaches the network, so it is not a replay and the pages it gets are
 * whatever the web serves today. Relevance is still a judgement, so the
 * classification step takes a review file exactly as the full diagnostic does.
 *
 *   node tools/retrieval-probe.js
 *   node tools/retrieval-probe.js --review reports/probe-review.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = 'reports';

/**
 * The questions, and why these.
 *
 * The first is the one that motivated `coverage_miss`: a page covering only
 * HTTP/2 satisfied coverage and the comparative pages were cancelled in flight.
 * The second is its control — the TLS page read in full and extracted to
 * headings, which must stay a passage miss and not drift into the new category.
 * The third has no known pathology and is here so a run where everything
 * behaves is distinguishable from a run where the probe is broken.
 */
export const PROBE_QUESTIONS = [
  'What causes head-of-line blocking in HTTP/2 but not in HTTP/3?',
  'What does TLS certificate pinning protect against, and what does it not?',
  'What is the purpose of a write-ahead log in database crash recovery?',
];

const TERMINAL = new Set(['usable', 'too_thin', 'failed', 'cancelled']);

/**
 * Retrieval for one question, traced.
 *
 * The funnel must be passed to `gatherFromWeb`: it takes one as a parameter, so
 * a probe that forgets records nothing and reports zero frozen events, which
 * reads exactly like a pass. `assertTraced` below refuses a result that could
 * have come from an untraced run.
 */
async function probeTraced(query) {
  const funnel = createFunnel({ question: query, enabled: true });
  const ledger = new EvidenceLedger();
  const budget = new Budget({
    maxIterations: 4,
    maxToolCalls: 12,
    maxFetches: 8,
    maxSearches: 2,
    wallClockMs: config.budgets.quick.wallClockMs ?? 60_000,
  });

  const started = Date.now();
  const coverage = await gatherFromWeb({ query, ledger, budget, emit: () => {}, pages: 2, funnel });
  const events = funnel.fetch_events;

  return {
    query,
    duration_ms: Date.now() - started,
    funnel: funnel.toJSON(),
    sources: ledger.publicSources().map((s) => ({ n: s.n, title: s.title, url: s.url })),
    coverage_ok: coverage?.ok ?? null,
    stop_reason: funnel.stop_reason,
    fetch_status_counts: events.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {}),
    events_total: events.length,
    events_terminal: events.filter((e) => TERMINAL.has(e.status)).length,
    events_still_attempted: events.filter((e) => e.status === 'attempted').length,
    events_cancelled: events.filter((e) => e.status === 'cancelled').length,
  };
}

/**
 * A probe that recorded nothing is not a probe that found nothing.
 *
 * Zero frozen events is the result this run exists to demonstrate, and an
 * untraced run produces it for free. So a probe that came back with no searches
 * and no fetch events at all is refused rather than reported.
 */
export function assertTraced(result) {
  const searches = result.funnel?.searches ?? [];
  // No search record at all means the funnel never reached retrieval. That is a
  // wiring fault in the probe and there is nothing to report.
  if (!searches.length) {
    throw new Error(`no search was recorded for "${result.query}": the funnel was not wired through`);
  }

  // A search that ran and returned nothing is a different thing entirely: the
  // provider refused or found nothing, retrieval behaved correctly, and this
  // question simply cannot test what the probe is for. Marked unusable rather
  // than thrown, so the questions that did run are still reported, and rather
  // than counted as a pass, because zero frozen events out of zero fetches
  // demonstrates nothing.
  const returned = searches.reduce((a, s) => a + (s.results?.length ?? 0), 0);
  if (!returned) {
    return { ...result, usable: false, unusable_reason: searches[0]?.error ?? 'the search returned no results' };
  }
  if (!result.events_total) {
    return { ...result, usable: false, unusable_reason: 'results were returned but no fetch was attempted' };
  }
  return { ...result, usable: true };
}

export function reviewTemplate(report) {
  return {
    _README: [
      'relevant_urls: the results that could have answered the question. Judgement, not a score.',
      'extracted_passages_contain_answer: did the text actually extracted carry the answer?',
      'Leave a field null to say you have not decided; the outcome stays pending_review.',
    ],
    ran_at: report.ran_at,
    questions: report.probes.map((p) => ({
      question: p.query,
      candidates: (p.funnel.searches ?? []).flatMap((s) =>
        s.results.map((r) => ({
          rank: r.rank,
          url: r.url,
          title: r.title,
          fetch_status: (p.funnel.fetch_events ?? []).find((e) => e.url === r.url)?.status ?? 'not_attempted',
        })),
      ),
      relevant_urls: null,
      extracted_passages_contain_answer: null,
      answer_addressed_question: null,
      answer_complete: null,
      notes: '',
    })),
  };
}

export function render(report) {
  const L = [];
  const A = (line = '') => L.push(line);

  A('# Retrieval probe, after the instrumentation fix\n');
  A('> Retrieval only: no synthesis, no model call. Three questions, one run each.');
  A('> It reaches the live web, so the pages are whatever is served today.\n');
  A(`- commit: \`${report.commit}\``);
  A(`- ran: ${report.ran_at}\n`);

  const unusable = report.probes.filter((p) => p.usable === false);
  if (unusable.length) {
    A('## Questions that could not be probed\n');
    A('| question | why |');
    A('|---|---|');
    for (const p of unusable) A(`| ${p.query.slice(0, 44)} | ${p.unusable_reason} |`);
    A('');
    A('These are not passes. Zero frozen events out of zero fetches demonstrates');
    A('nothing, so they are excluded from the counts below.\n');
  }

  A('## Does every started fetch reach a terminal status?\n');
  A('| question | events | terminal | still attempted | cancelled |');
  A('|---|---:|---:|---:|---:|');
  const usable = report.probes.filter((p) => p.usable !== false);
  for (const p of usable) {
    A(`| ${p.query.slice(0, 44)} | ${p.events_total} | ${p.events_terminal} | ${p.events_still_attempted} | ${p.events_cancelled} |`);
  }
  if (!usable.length) A('| _no question produced a fetch_ | — | — | — | — |');
  const frozen = usable.reduce((a, p) => a + p.events_still_attempted, 0);
  const cancelled = usable.reduce((a, p) => a + p.events_cancelled, 0);
  A('');
  A(
    !usable.length
      ? 'Nothing was fetched, so this run demonstrates neither claim. It is not evidence that the fix works.'
      : frozen === 0
        ? `No event remained at \`attempted\`. ${cancelled} were recorded as \`cancelled\`, a status the e2e0e46 run never produced.`
        : `${frozen} event(s) never reached a terminal status. The fix is not doing what it claims.`,
  );
  A('');

  A('## Where each one stopped\n');
  A('| question | stop reason | coverage met | statuses |');
  A('|---|---|---|---|');
  for (const p of usable) {
    A(`| ${p.query.slice(0, 40)} | ${p.stop_reason ?? '—'} | ${p.coverage_ok} | ${JSON.stringify(p.fetch_status_counts)} |`);
  }
  A('');

  if (report.outcomes?.length) {
    A('## Classified, after review\n');
    A('| question | outcome | why |');
    A('|---|---|---|');
    for (const o of report.outcomes) A(`| ${o.query.slice(0, 40)} | ${o.primary} | ${o.flags?.[0] ?? ''} |`);
    A('');
  } else {
    A('## Not yet classified\n');
    A('Relevance is a judgement, so the outcomes are unreviewed. Fill in');
    A('`reports/probe-review.json` and run this again with `--review`.\n');
  }
  return `${L.join('\n')}\n`;
}

async function main() {
  const reviewPath = flag('review', null);
  const existing = fs.existsSync(path.join(OUT, 'retrieval-probe.json'))
    ? JSON.parse(fs.readFileSync(path.join(OUT, 'retrieval-probe.json'), 'utf8'))
    : null;

  // With a review, nothing is re-run: the saved probe is classified. Searching
  // again would classify a different set of pages from the ones reviewed.
  if (reviewPath) {
    if (!existing) throw new Error('there is no saved probe to classify; run without --review first');
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const byQuestion = new Map((review.questions ?? []).map((q) => [q.question, q]));
    existing.reviewed_at = new Date().toISOString();
    existing.outcomes = existing.probes.map((p) => {
      const annotation = byQuestion.get(p.query) ?? null;
      const funnel = {
        candidates: (p.funnel.searches ?? []).flatMap((s) => s.results.map((r) => ({ ...r, search_attempt: s.attempt }))),
        fetch_events: p.funnel.fetch_events ?? [],
        stop_reason: p.funnel.stop_reason ?? null,
      };
      const outcome = classifyRetrieval(funnel, {
        citedSentences: 0,
        supportedSentences: 0,
        review: annotation && Array.isArray(annotation.relevant_urls) ? annotation : null,
      });
      return { query: p.query, ...outcome };
    });
    fs.writeFileSync(path.join(OUT, 'retrieval-probe.json'), `${JSON.stringify(existing, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT, 'retrieval-probe.md'), render(existing));
    console.log('classified the saved probe');
    for (const o of existing.outcomes) console.log(`  ${o.primary.padEnd(22)} ${o.query.slice(0, 50)}`);
    return;
  }

  const lock = acquireLock(OUT, { name: '.retrieval-probe.lock' });
  const probes = [];
  try {
    for (const query of PROBE_QUESTIONS) {
      process.stderr.write(`  ${query.slice(0, 58)}\n`);
      const result = assertTraced(await probeTraced(query));
      if (!result.usable) process.stderr.write(`    unusable: ${result.unusable_reason}\n`);
      probes.push(result);
    }
  } finally {
    lock.release();
  }

  const report = {
    _LIMITATIONS: [
      'Retrieval only. No synthesis and no model call, so it says nothing about answers.',
      'Three questions, one run each. It tests whether two mechanisms work, not how often they fire.',
      'Live web: the pages are whatever is served today, not the ones the e2e0e46 run saw.',
    ],
    commit: process.env.PROBE_COMMIT ?? null,
    ran_at: new Date().toISOString(),
    probes,
  };
  fs.writeFileSync(path.join(OUT, 'retrieval-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'retrieval-probe.md'), render(report));

  const templatePath = path.join(OUT, 'probe-review.json');
  if (!fs.existsSync(templatePath)) fs.writeFileSync(templatePath, `${JSON.stringify(reviewTemplate(report), null, 2)}\n`);

  console.log(`\nwrote ${OUT}/retrieval-probe.json and .md`);
  for (const p of probes) {
    console.log(
      `  ${p.query.slice(0, 44).padEnd(46)} stop=${String(p.stop_reason).padEnd(20)} ${JSON.stringify(p.fetch_status_counts)}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
