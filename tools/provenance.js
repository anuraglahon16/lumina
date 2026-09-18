#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snippetIsGrounded, citationNumbers } from '../benchmark/lib.mjs';

/**
 * The assignment's citation-grounding gate, measured on a saved run.
 *
 * `benchmark/sla.json` sets `min_citation_grounding: 0.95` and that is the only
 * citation gate in the provided assets. The word "completeness" appears nowhere
 * in them; it is an internal metric.
 *
 * More importantly the gate does not measure what this project's internal
 * groundedness measures. `bench.mjs` asks two questions per distinct `[n]`:
 * does the marker resolve to a source in the answer, and is that source's
 * *snippet* present, normalised, as a contiguous twelve-token window in the
 * page it points at. That is provenance — did you really read this page and is
 * the excerpt you showed really on it. The internal metric asks whether a
 * sentence follows from a passage. Neither number estimates the other, and
 * reporting one as the other is how a project convinces itself it has measured
 * a gate it has not touched.
 *
 * So the scoring functions are imported from the benchmark rather than
 * reimplemented. A second copy of `snippetIsGrounded` would drift, and a third
 * incompatible "grounding" number is the last thing this project needs.
 *
 * What this is not: the benchmark. It scores answers from a saved run rather
 * than driving the contract path, and it re-fetches pages today that were read
 * weeks ago. It is an estimate of the gate, reported as one.
 *
 *   node tools/provenance.js --run reports/grounding-diagnostic.json
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const stripHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

const pageCache = new Map();

async function fetchPageText(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  let text = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'lumina-provenance/0.1 (+internal check)' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) text = stripHtml(await res.text());
  } catch {
    text = null;
  }
  pageCache.set(url, text);
  return text;
}

/**
 * Why a citation failed to verify, told apart rather than lumped together.
 *
 * A page that blocks the checker and a snippet that was never on the page are
 * both "not verified" and mean opposite things: one is a publisher's robots
 * policy, the other is the system showing an excerpt it did not read. The
 * benchmark excludes blocked fetches from the ratio for exactly that reason,
 * and reporting them as unsupported content would be the same error in
 * reverse.
 *
 * `page_changed` and `snippet_absent` are separated by the run's own saved
 * text. If the snippet is in what we extracted at the time but not in the page
 * today, the page moved under us. If it is in neither, the snippet never came
 * from that page and the fault is ours.
 */
export const OUTCOMES = {
  VERIFIED: 'provenance_verified',
  DANGLING: 'dangling_citation',
  BLOCKED: 'page_fetch_blocked',
  CHANGED: 'page_changed_since_run',
  ABSENT: 'snippet_absent_from_page',
};

/** Every passage the run saved for a source, for the changed-versus-absent split. */
function savedTextFor(record, url) {
  const parts = [];
  for (const event of record.funnel?.fetch_events ?? []) {
    if (event.url === url && event.extracted_passages?.length) parts.push(event.extracted_passages.join('\n'));
  }
  for (const decision of record.sentence_results ?? []) {
    for (const scored of decision.scored_against ?? []) {
      const source = (record.sources ?? []).find((s) => s.n === scored.n);
      if (source?.url === url && scored.passages?.length) parts.push(scored.passages.join('\n'));
    }
  }
  return parts.join('\n');
}

export async function scoreRun(record, { fetchPage = fetchPageText } = {}) {
  const bySource = new Map((record.sources ?? []).map((s) => [s.n, s]));
  const checks = [];

  for (const n of citationNumbers(record.answer ?? '')) {
    const source = bySource.get(n);
    if (!source) {
      // Counted, never grounded: the benchmark's automatic-fail case.
      checks.push({ n, outcome: OUTCOMES.DANGLING, url: null });
      continue;
    }
    const page = source.url ? await fetchPage(source.url) : null;
    if (!page) {
      checks.push({ n, outcome: OUTCOMES.BLOCKED, url: source.url });
      continue;
    }
    if (snippetIsGrounded(source.snippet, page)) {
      checks.push({ n, outcome: OUTCOMES.VERIFIED, url: source.url });
      continue;
    }
    const saved = savedTextFor(record, source.url);
    checks.push({
      n,
      outcome: saved && snippetIsGrounded(source.snippet, saved) ? OUTCOMES.CHANGED : OUTCOMES.ABSENT,
      url: source.url,
      snippet: String(source.snippet ?? '').slice(0, 160),
    });
  }
  return { query: record.query, checks };
}

/** The ratio exactly as bench.mjs computes it: grounded over verifiable. */
export function summarise(runs) {
  const all = runs.flatMap((r) => r.checks);
  const count = (o) => all.filter((c) => c.outcome === o).length;

  const checked = all.length;
  const blocked = count(OUTCOMES.BLOCKED);
  const grounded = count(OUTCOMES.VERIFIED);
  const verifiable = checked - blocked;

  return {
    checked,
    verifiable,
    grounded,
    dangling: count(OUTCOMES.DANGLING),
    blocked,
    changed: count(OUTCOMES.CHANGED),
    absent: count(OUTCOMES.ABSENT),
    // bench.mjs: grounded / (checked - unverifiable). Dangling citations stay
    // in the denominator, which is what makes one an automatic fail.
    citation_grounding: verifiable > 0 ? grounded / verifiable : null,
  };
}

export function render(report) {
  const s = report.summary;
  const L = [];
  const A = (line = '') => L.push(line);

  A("# Citation provenance: the assignment's actual gate\n");
  A('> Not the benchmark. This scores answers from a saved run rather than');
  A('> driving the contract path, and it re-fetches today pages that were read');
  A('> weeks ago. It is an estimate of the gate, using the benchmark\'s own');
  A('> scoring functions rather than a second copy of them.\n');
  A(`- run: \`${report.commit}\` (${report.ran_at})`);
  A(`- checked: ${report.ran_provenance_at}`);
  A(`- gate: \`min_citation_grounding\` >= ${report.target}\n`);

  A('## What the gate measures, and what it does not\n');
  A('For each distinct `[n]` in an answer: does it resolve to a source, and is');
  A("that source's snippet present as a contiguous 12-token window in the page");
  A('it names. That is provenance, not entailment. The internal groundedness');
  A('figures reported elsewhere in this directory ask a different question and');
  A('are not estimates of this one.\n');

  A('## Result\n');
  A(`| citation grounding | **${s.citation_grounding === null ? '—' : s.citation_grounding.toFixed(3)}** |`);
  A('|---|---:|');
  A(`| target | ${report.target} |`);
  A(`| ${s.citation_grounding === null ? 'unmeasured' : s.citation_grounding >= report.target ? 'meets the target on this sample' : 'below the target on this sample'} | |`);
  A('');

  A('## Every citation, by outcome\n');
  A('| outcome | citations | in the ratio |');
  A('|---|---:|---|');
  A(`| provenance verified | ${s.grounded} | numerator and denominator |`);
  A(`| snippet absent from the page | ${s.absent} | denominator only |`);
  A(`| page changed since the run | ${s.changed} | denominator only |`);
  A(`| **dangling citation** | ${s.dangling} | denominator only, automatic fail |`);
  A(`| page fetch blocked | ${s.blocked} | excluded from both |`);
  A(`| **total** | **${s.checked}** | |`);
  A('');
  A('A blocked fetch is not unsupported content. A publisher that refuses this');
  A('checker makes a citation unverifiable, not false, and counting it against');
  A('the system would teach nobody anything.');
  A('');
  A('`page changed` and `snippet absent` are told apart by the run\'s own saved');
  A('text: if the snippet is in what we extracted at the time but not in the page');
  A('today, the page moved. If it is in neither, the snippet never came from that');
  A('page, and that one is ours.\n');

  if (s.dangling || s.absent) {
    A('## The ones that are ours\n');
    for (const run of report.runs) {
      for (const c of run.checks) {
        if (c.outcome !== OUTCOMES.DANGLING && c.outcome !== OUTCOMES.ABSENT) continue;
        A(`- **${c.outcome}** [${c.n}] in "${run.query.slice(0, 50)}"${c.url ? ` → ${c.url}` : ' (no such source)'}`);
      }
    }
    A('');
  }
  return `${L.join('\n')}\n`;
}

async function main() {
  const runPath = flag('run', 'reports/grounding-diagnostic.json');
  const slaPath = flag('sla', 'benchmark/sla.json');
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const sla = JSON.parse(fs.readFileSync(slaPath, 'utf8'));

  const runs = [];
  for (const record of (run.runs ?? []).filter((r) => !r.error)) {
    process.stderr.write(`  ${record.query.slice(0, 56)}\n`);
    runs.push(await scoreRun(record));
  }

  const report = {
    _LIMITATIONS: [
      'Not the official benchmark: saved answers, not the contract path.',
      'Pages are re-fetched today; the run read them weeks ago, so page_changed is expected and is reported separately.',
      'Uses benchmark/lib.mjs scoring directly, so it cannot drift from the gate it estimates.',
    ],
    commit: run.commit,
    ran_at: run.ran_at,
    ran_provenance_at: new Date().toISOString(),
    target: sla.sla?.min_citation_grounding ?? 0.95,
    summary: summarise(runs),
    runs,
  };

  fs.writeFileSync(path.join('reports', 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join('reports', 'provenance.md'), render(report));
  const s = report.summary;
  console.log(`\nwrote reports/provenance.json and .md`);
  console.log(
    `citation grounding ${s.citation_grounding === null ? '—' : s.citation_grounding.toFixed(3)} ` +
      `(${s.grounded}/${s.verifiable} verifiable) · dangling ${s.dangling} · blocked ${s.blocked} · changed ${s.changed} · absent ${s.absent}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
