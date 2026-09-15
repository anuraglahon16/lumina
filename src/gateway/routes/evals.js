import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { shell, esc } from './pageShell.js';

/**
 * `/evals`: the most recent evaluation report, rendered.
 *
 * The harness already writes `eval/results-*.json` and prints to a terminal
 * nobody reading a deployment can see. This serves the same numbers as a page,
 * so the evidence for "does it work" travels with the deployment.
 *
 * Contracts and quality are shown separately and deliberately styled
 * differently, because they are different claims. A contract must hold on every
 * run; anything below 100% is a failure, not a low score. Quality metrics are
 * distributions and are shown with their confidence interval.
 */


/**
 * Where a report might be.
 *
 * In a container the repo's `eval/` directory is baked in at build time, so a
 * report written afterwards never appears there: a deployed /evals would sit
 * empty forever. Reports are therefore looked for on a writable volume too, and
 * the location is configurable so the harness and this page can be pointed at
 * the same place.
 */
function candidateDirs() {
  const dirs = [];
  if (process.env.EVAL_RESULTS_DIR) dirs.push(process.env.EVAL_RESULTS_DIR);
  if (process.env.DATA_DIR) dirs.push(path.join(process.env.DATA_DIR, 'eval'));
  dirs.push(path.join(config.root, 'eval'));
  return [...new Set(dirs)];
}

function latestReport() {
  let newest = null;
  for (const dir of candidateDirs()) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^results-.*\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file: f, full, mtime };
      } catch {
        /* unreadable entry, keep looking */
      }
    }
  }
  if (!newest) return null;
  try {
    return { file: newest.file, report: JSON.parse(fs.readFileSync(newest.full, 'utf8')) };
  } catch {
    return null;
  }
}

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const ms = (v) => (v == null ? 'n/a' : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);
const usd = (v) => (v == null ? 'n/a' : `$${v.toFixed(4)}`);

const interval = (band, fmt) =>
  band?.lo == null ? fmt(band?.mean) : `${fmt(band.mean)} <span class="ci">[${fmt(band.lo)}, ${fmt(band.hi)}]</span>`;

function renderCase(c) {
  const contracts = Object.entries(c.contracts || {})
    .filter(([, r]) => r.n > 0)
    .map(([name, r]) => {
      const held = r.mean >= 1;
      return `<tr class="${held ? 'pass' : 'fail'}">
        <td>${held ? '✓' : '✗'} ${esc(name.replace(/_/g, ' '))}</td>
        <td class="num">${pct(r.mean)}</td>
        <td class="num dim">n=${r.n}</td></tr>`;
    })
    .join('');

  const quality = [
    ['groundedness', interval(c.quality?.groundedness, pct)],
    ['citation coverage', interval(c.quality?.citation_coverage, pct)],
    ['key-term recall', c.quality?.mention_recall?.n ? interval(c.quality.mention_recall, pct) : null],
    ['latency', interval(c.performance?.latency_ms, ms)],
    ['time to first token', interval(c.performance?.ttft_ms, ms)],
    ['cost', interval(c.performance?.cost_usd, usd)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`)
    .join('');

  const termination = Object.entries(c.termination_reasons || {})
    .map(([k, v]) => `<span class="chip">${esc(k)} ×${v}</span>`)
    .join(' ');

  return `<section class="case">
    <h2>${esc(c.case_id)} <span class="badge">${esc(c.mode)}</span>
      <span class="dim">${c.runs} runs${c.failures ? `, ${c.failures} errored` : ''}</span></h2>
    <div class="grid">
      <div><h3>Contracts <span class="dim">must hold on every run</span></h3><table>${contracts || '<tr><td class="dim">none recorded</td></tr>'}</table></div>
      <div><h3>Quality and cost <span class="dim">mean [95% CI]</span></h3><table>${quality}</table></div>
    </div>
    ${termination ? `<div class="term">termination: ${termination}</div>` : ''}
  </section>`;
}

export function evalsPage(req, res) {
  const found = latestReport();

  if (!found) {
    return res.status(200).type('html').send(page(`
      <section class="case">
        <h2>No evaluation report yet</h2>
        <p class="dim">Run the harness against a running stack, then reload:</p>
        <pre>node eval/run-eval.js --repeats 5</pre>
        <p class="dim">It writes <code>eval/results-&lt;timestamp&gt;.json</code>, and this page renders the newest one.</p>
      </section>`));
  }

  const { file, report } = found;
  const cases = (report.cases || []).map(renderCase).join('');
  const failed = (report.cases || []).flatMap((c) =>
    Object.entries(c.contracts || {}).filter(([, r]) => r.n > 0 && r.mean < 1).map(([n]) => `${c.case_id}: ${n}`),
  );

  res.type('html').send(page(`
    <div class="verdict ${failed.length ? 'bad' : 'good'}">
      ${failed.length
        ? `${failed.length} contract violation${failed.length > 1 ? 's' : ''}: ${failed.map(esc).join(', ')}`
        : 'All contracts held on every run'}
    </div>
    <p class="dim meta">${esc(file)}${report.started_at ? ` · ${esc(report.started_at)}` : ''}${
      report.model ? ` · ${esc(report.model)}` : ''
    }${
      // Which stack produced these numbers. A report measured elsewhere is
      // still useful, but it should never be mistaken for this deployment's.
      report.base ? ` · measured against ${esc(report.base)}` : ''
    }</p>
    ${cases}`));
}

function page(body) {
  return shell({
    title: 'LUMINA evaluation',
    active: '/evals',
    lede: 'Contracts must hold on every run. Quality and cost are distributions, reported with a 95% interval.',
    css: EVAL_CSS,
    body,
  });
}

const EVAL_CSS = `
  .case { background:var(--raised); border:1px solid var(--border); border-radius:12px; padding:18px; margin-bottom:14px; }
  .meta { font-family:var(--mono); font-size:11.5px; margin:0 0 22px; }
  .verdict { padding:12px 14px; border-radius:10px; border:1px solid var(--border); margin:18px 0 6px; font-weight:550; }
  .verdict.good { color:var(--ok); }
  .verdict.bad { color:var(--bad); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:22px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:3px 0; vertical-align:baseline; }
  td.num { text-align:right; font-family:var(--mono); font-size:12px; white-space:nowrap; }
  td.dim { width:52px; }
  tr.pass td:first-child { color:var(--ok); }
  tr.fail td { color:var(--bad); font-weight:600; }
  .ci { color:var(--faint); font-weight:400; }
  .chip { margin-right:4px; }
  .term { margin-top:14px; padding-top:12px; border-top:1px solid var(--border); font-size:12px; color:var(--dim); }
`;
