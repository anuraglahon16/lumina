/**
 * LUMINA evaluation harness.
 *
 *   node eval/run-eval.js                    # every case, 3 repeats
 *   node eval/run-eval.js --repeats 5 --mode quick --case comparison
 *   node eval/run-eval.js --judge            # add an LLM faithfulness judge
 *
 * Each case is run N times because a single run of a stochastic agent over a
 * changing web tells you almost nothing. Every metric is reported as a mean
 * with a 95% interval, and per-run values are kept so you can see the spread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EVAL_BASE || 'http://localhost:8080';

/**
 * A deployment worth measuring is usually one that is protected, so the harness
 * has to present the same credential a browser would. Without this it can only
 * ever grade a stack with the gate turned off, which is not the stack anyone is
 * actually running.
 */
const AUTH = process.env.DEMO_PASSWORD
  ? { authorization: `Basic ${Buffer.from(`eval:${process.env.DEMO_PASSWORD}`).toString('base64')}` }
  : {};
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const REPEATS = Number(flag('repeats', 3));
const ONLY_MODE = flag('mode', null);
const ONLY_CASE = flag('case', null);
const USER = `usr_eval${Date.now().toString(36)}`;

const { cases } = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const selected = cases.filter((c) => (!ONLY_MODE || c.mode === ONLY_MODE) && (!ONLY_CASE || c.id === ONLY_CASE));

/* ------------------------------------------------------------- statistics */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * 95% interval from the t distribution. With the small N an eval like this can
 * afford, reporting a point estimate alone would be misleading.
 */
function interval95(xs) {
  const values = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (values.length < 2) return { mean: mean(values), lo: null, hi: null, n: values.length };
  const m = mean(values);
  const sd = Math.sqrt(values.reduce((acc, x) => acc + (x - m) ** 2, 0) / (values.length - 1));
  // t critical values for 95% two-sided, df = n-1.
  const T = { 1: 12.71, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };
  const t = T[values.length - 1] ?? 1.96;
  const half = t * (sd / Math.sqrt(values.length));
  return { mean: m, lo: m - half, hi: m + half, sd, n: values.length };
}

const rate = (successes, n) => {
  if (!n) return { mean: null, lo: null, hi: null, n: 0 };
  const p = successes / n;
  // Wilson interval: behaves sensibly at 0/N and N/N, unlike the normal approximation.
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { mean: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
};

/* ----------------------------------------------------------------- one run */

async function runOnce(testCase) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/query`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify({ query: testCase.query, mode: testCase.mode }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
  }

  const observed = {
    ok: true,
    answer: '',
    sources: [],
    plan: null,
    done: null,
    citations: null,
    capped: null,
    error: null,
    sources_at_ms: null,
    first_token_at_ms: null,
    tool_sequence: [],
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = null;
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!event || !dataLines.length) continue;
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      const at = Math.round(performance.now() - t0);
      if (event === 'sources') {
        observed.sources = data.sources;
        observed.sources_at_ms ??= at;
      } else if (event === 'token') {
        observed.first_token_at_ms ??= at;
      } else if (event === 'answer') observed.answer = data.text;
      else if (event === 'citations') observed.citations = data;
      else if (event === 'plan') observed.plan = data;
      else if (event === 'capped') observed.capped = data;
      else if (event === 'error') observed.error = data;
      else if (event === 'done') observed.done = data;
      else if (event === 'tool_call') observed.tool_sequence.push(data.tool);
    }
  }
  return observed;
}

/* --------------------------------------------------------------- scoring */

function score(testCase, run) {
  if (!run.ok) return { failed: true, error: run.error };
  const answer = (run.answer || '').toLowerCase();
  const expect = testCase.expect || {};
  const done = run.done || {};

  const mentions = (expect.must_mention || []).filter((term) => answer.includes(term.toLowerCase()));
  const searchedThenFetched =
    run.tool_sequence.indexOf('web_search') !== -1 &&
    run.tool_sequence.indexOf('fetch_page') > run.tool_sequence.indexOf('web_search');

  return {
    failed: Boolean(run.error),
    error: run.error?.message || null,

    // Contract checks. These should be true on every run, not on average.
    sources_before_tokens:
      run.sources_at_ms !== null && run.first_token_at_ms !== null ? run.sources_at_ms <= run.first_token_at_ms : null,
    no_invalid_citations: (run.citations?.invalid_citations?.length || 0) === 0,
    search_then_fetch: run.tool_sequence.includes('web_search') ? searchedThenFetched : null,
    honest_when_capped: run.capped ? /partial|cut short|limit|incomplete/i.test(run.answer || '') : null,
    mode_respected: done.mode === testCase.mode,
    deep_planned: testCase.mode === 'deep' ? (run.plan?.sub_questions?.length || 0) >= (expect.min_sub_questions || 2) : null,

    // Quality signals.
    sources: run.sources.length,
    enough_sources: run.sources.length >= (expect.min_sources ?? 0),
    cited_sources: run.citations?.cited?.length || 0,
    citation_coverage: run.sources.length ? (run.citations?.cited?.length || 0) / run.sources.length : null,
    groundedness: run.citations?.groundedness ?? null,
    mention_recall: expect.must_mention?.length ? mentions.length / expect.must_mention.length : null,
    expressed_uncertainty: expect.expect_uncertainty
      ? /(could not|couldn't|no (public |reliable )?(evidence|information|sources)|not (publicly )?available|unable to (find|verify))/i.test(run.answer || '')
      : null,

    // Cost and latency.
    latency_ms: done.latency_ms ?? null,
    ttft_ms: done.ttft_ms ?? null,
    cost_usd: done.cost_usd ?? null,
    input_tokens: done.tokens?.input ?? null,
    output_tokens: done.tokens?.output ?? null,
    tool_calls: done.tool_calls ?? null,
    cache_hits: done.cache?.hits ?? null,
    termination_reason: done.termination_reason,
    capped: Boolean(run.capped),
    answer_chars: (run.answer || '').length,
  };
}

/* ------------------------------------------------------------- LLM judge */

async function judge(testCase, run) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const evidence = run.sources
    .map((s) => `[${s.n}] ${s.title} (${s.domain})\n${s.snippet}`)
    .join('\n\n')
    .slice(0, 20000);

  const message = await client.messages.create({
    model: process.env.LUMINA_FAST_MODEL || 'claude-haiku-4-5',
    max_tokens: 1200,
    system:
      'You grade a research assistant\'s answer. Be strict and literal. An answer that admits it lacks evidence scores well on faithfulness. Respond with JSON only: {"faithfulness":0-1,"relevance":0-1,"completeness":0-1,"unsupported_claims":["..."],"note":"one sentence"}',
    messages: [
      {
        role: 'user',
        content: `<question>${testCase.query}</question>\n\n<evidence_summaries>\n${evidence}\n</evidence_summaries>\n\n<answer>\n${run.answer}\n</answer>`,
      },
    ],
  });
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text.replace(/```json?|```/g, '').trim());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ report */

const pct = (v) => (v == null ? ' n/a ' : `${(v * 100).toFixed(0)}%`.padStart(5));
const ms = (v) => (v == null ? 'n/a' : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);
const band = (i, fmt) => (i.lo == null ? fmt(i.mean) : `${fmt(i.mean)} [${fmt(i.lo)}, ${fmt(i.hi)}]`);

async function main() {
  console.log(`\nLUMINA eval · ${selected.length} case(s) × ${REPEATS} repeats · ${BASE}\n`);
  const health = await fetch(`${BASE}/health`, { headers: AUTH }).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error('Gateway unreachable. Start the stack with `npm run dev`.');
    process.exit(1);
  }
  console.log(`search: ${health.agent?.checks?.search_provider} · embeddings: ${health.agent?.checks?.embedding_provider}`);
  if (health.agent?.checks?.search_degraded) console.log('⚠ keyless fallback search is active, expect lower source quality\n');

  const report = { started_at: new Date().toISOString(), base: BASE, repeats: REPEATS, cases: [] };

  for (const testCase of selected) {
    process.stdout.write(`\n\x1b[1m${testCase.id}\x1b[0m (${testCase.mode}) ${testCase.query.slice(0, 68)}…\n`);
    const scores = [];
    for (let i = 0; i < REPEATS; i += 1) {
      process.stdout.write(`  run ${i + 1}/${REPEATS} … `);
      const run = await runOnce(testCase);
      const s = score(testCase, run);
      if (has('judge') && run.ok && run.answer) s.judge = await judge(testCase, run).catch(() => null);
      scores.push(s);
      process.stdout.write(
        s.failed
          ? `\x1b[31mfailed: ${s.error}\x1b[0m\n`
          : `${ms(s.latency_ms)} · ${s.sources} sources · ${s.cited_sources} cited · $${(s.cost_usd ?? 0).toFixed(4)} · ${s.termination_reason}\n`,
      );
    }

    const ok = scores.filter((s) => !s.failed);
    const boolRate = (key) => {
      const applicable = ok.filter((s) => s[key] !== null && s[key] !== undefined);
      return rate(applicable.filter((s) => s[key]).length, applicable.length);
    };
    const numeric = (key) => interval95(ok.map((s) => s[key]).filter((v) => typeof v === 'number'));

    const summary = {
      case_id: testCase.id,
      mode: testCase.mode,
      runs: scores.length,
      failures: scores.length - ok.length,
      contracts: {
        sources_before_tokens: boolRate('sources_before_tokens'),
        no_invalid_citations: boolRate('no_invalid_citations'),
        search_then_fetch: boolRate('search_then_fetch'),
        mode_respected: boolRate('mode_respected'),
        honest_when_capped: boolRate('honest_when_capped'),
        deep_planned: boolRate('deep_planned'),
      },
      quality: {
        enough_sources: boolRate('enough_sources'),
        groundedness: numeric('groundedness'),
        citation_coverage: numeric('citation_coverage'),
        mention_recall: numeric('mention_recall'),
        expressed_uncertainty: boolRate('expressed_uncertainty'),
      },
      performance: {
        latency_ms: numeric('latency_ms'),
        ttft_ms: numeric('ttft_ms'),
        cost_usd: numeric('cost_usd'),
        tool_calls: numeric('tool_calls'),
        output_tokens: numeric('output_tokens'),
      },
      termination_reasons: ok.reduce((acc, s) => ({ ...acc, [s.termination_reason]: (acc[s.termination_reason] || 0) + 1 }), {}),
      runs_detail: scores,
    };
    report.cases.push(summary);

    console.log(`  ── contracts ─────────────────────────────────`);
    for (const [name, r] of Object.entries(summary.contracts)) {
      if (r.n === 0) continue;
      const bad = r.mean < 1;
      console.log(`   ${bad ? '\x1b[31m✗' : '\x1b[32m✓'}\x1b[0m ${name.padEnd(24)} ${pct(r.mean)}  (n=${r.n})`);
    }
    console.log(`  ── quality (mean [95% CI]) ───────────────────`);
    console.log(`     groundedness           ${band(summary.quality.groundedness, (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`))}`);
    console.log(`     citation coverage      ${band(summary.quality.citation_coverage, (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`))}`);
    if (summary.quality.mention_recall.n) console.log(`     key-term recall        ${band(summary.quality.mention_recall, (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`))}`);
    console.log(`  ── performance ───────────────────────────────`);
    console.log(`     latency                ${band(summary.performance.latency_ms, ms)}`);
    console.log(`     time to first token    ${band(summary.performance.ttft_ms, ms)}`);
    console.log(`     cost                   ${band(summary.performance.cost_usd, (v) => (v == null ? 'n/a' : `$${v.toFixed(4)}`))}`);
    console.log(`     tool calls             ${band(summary.performance.tool_calls, (v) => (v == null ? 'n/a' : v.toFixed(1)))}`);
    console.log(`     termination            ${Object.entries(summary.termination_reasons).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }

  // Written where the gateway can serve it from: in a container that must be a
  // mounted volume, not the image's baked-in eval directory.
  const outDir = process.env.EVAL_RESULTS_DIR || dir;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  const contractFailures = report.cases.flatMap((c) =>
    Object.entries(c.contracts).filter(([, r]) => r.n > 0 && r.mean < 1).map(([name]) => `${c.case_id}: ${name}`),
  );
  console.log(`\n\x1b[1mSummary\x1b[0m`);
  console.log(`  total runs: ${report.cases.reduce((a, c) => a + c.runs, 0)} · failures: ${report.cases.reduce((a, c) => a + c.failures, 0)}`);
  console.log(
    `  total cost: $${report.cases
      .reduce((a, c) => a + (c.performance.cost_usd.mean || 0) * c.runs, 0)
      .toFixed(4)}`,
  );
  if (contractFailures.length) {
    console.log(`  \x1b[31mcontract violations:\x1b[0m\n    ${contractFailures.join('\n    ')}`);
  } else {
    console.log(`  \x1b[32mall contracts held on every run\x1b[0m`);
  }
  console.log(`  written to ${path.relative(process.cwd(), out)}\n`);
  process.exit(contractFailures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('eval crashed:', err);
  process.exit(1);
});
