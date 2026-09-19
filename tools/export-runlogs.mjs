#!/usr/bin/env node
/**
 * Write our run records out in the contract's `RunLog` shape.
 *
 * `quality/check.mjs` reads `runs/<requestId>.json` and expects the shape
 * `packages/contract/src/db.ts` calls `RunLog`: a single `tokens` total, a
 * `terminated` of `done | cap | error`, `wallClockSec`, `costUsd`, and a
 * `toolCalls` array whose failures carry a non-empty `error`.
 *
 * What we store internally is richer and differently named — `tokens` is the
 * four-way split the provider reports, `termination_reason` carries the harness's
 * own vocabulary (`sufficient_evidence`, `max_tool_calls_reached`, …) — because
 * those are what a diagnosis needs. The provided `scripts/export-runs.mjs` dumps
 * the collection verbatim, which for us produced files with one field in them,
 * and six of the quality gates read nothing.
 *
 * The contract's own comment says the adapter is the deliverable: "Ten lines of
 * adapter; it is what the gates read." This is it. It is a separate tool rather
 * than an edit to the provided exporter, which states it is a convenience and
 * that the file shape is "the only contractual part".
 *
 *   node tools/export-runlogs.mjs              # from MONGODB_URI in .env
 *   node tools/export-runlogs.mjs --limit 300
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
config({ path: join(ROOT, '.env') });

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/**
 * Our termination vocabulary, mapped onto the contract's three.
 *
 * The distinction the gate cares about is whether the loop stopped because it
 * finished or because it ran out, so anything that is a cap maps to `cap` and
 * keeps its own name nowhere — the richer reason stays in our own record.
 */
/**
 * Every reason that means the run stopped because it ran out, enumerated from
 * what the store actually contains rather than from memory.
 *
 * The list was short by the two that matter most. `capped` is what deep.js
 * writes when a branch hits its limit - 59 runs in the store - and
 * `max_tokens` is a truncated answer. Both were falling through to `done`,
 * which reported a run that visibly ran out of budget as one that finished,
 * in the file the quality gates read. A2 exists to catch exactly that, and a
 * mapper that hides it from A2 defeats the rule while appearing to satisfy it.
 *
 * `evidence_limited` is deliberately not here: a run that searched, found
 * little, and said so in its answer finished its work. Thin evidence is a
 * result, not a cap.
 */
const CAP_REASONS = new Set([
  'capped',
  'max_tokens',
  'max_tool_calls_reached',
  'max_searches_reached',
  'max_fetches_reached',
  'max_iterations_reached',
  'wall_clock_exceeded',
  'retrieval_deadline',
  'budget_exhausted',
  'deep_tool_budget_exhausted',
  'cap',
]);

export function terminatedOf(run) {
  if (run.status === 'error' || (run.errors ?? []).length > 0) return 'error';
  const reason = run.termination_reason ?? '';
  if (CAP_REASONS.has(reason)) return 'cap';
  if (run.budget?.capped) return 'cap';
  return 'done';
}

/** The tool calls, with the invariant a failed one must carry an error string. */
export function toolCallsOf(run) {
  return (run.tool_calls ?? []).map((t) => {
    const ok = t.ok !== false;
    const call = { name: t.name, ok };
    if (typeof t.duration_ms === 'number') call.ms = Math.max(0, Math.round(t.duration_ms));
    // A1 is a red line: a failed call with an empty error reads as a silent
    // failure, which is the thing the gate exists to catch. If our record lost
    // the message, say so rather than emit an empty string and pass.
    if (!ok) call.error = String(t.error ?? '').trim() || 'error not recorded in the run log';
    return call;
  });
}

export function toRunLog(run) {
  const t = run.tokens ?? {};
  const tokens =
    typeof t === 'number' ? t : (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);

  return {
    tokens: Math.max(0, Math.round(tokens)),
    wallClockSec: Math.max(0, (run.latency_ms ?? 0) / 1000),
    costUsd: Math.max(0, run.cost_usd ?? 0),
    terminated: terminatedOf(run),
    ...(run.mode ? { depth: run.mode } : {}),
    // Not in the contract's RunLog, which is a strict subset, but it is in
    // RunDoc and `eval/build-report.mjs` renders it as the question a
    // trajectory answered. A trajectory without its question is a list of tool
    // names.
    ...(run.query ? { query: run.query } : {}),
    toolCalls: toolCallsOf(run),
  };
}

async function main() {
  const limit = Number(flag('limit', '300'));
  const outDir = join(ROOT, flag('out', 'runs'));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set; run logs live in Mongo for a deployed instance');

  const client = new MongoClient(uri);
  await client.connect();
  // Same database and sort key as the provided exporter, which is the one that
  // found records: the default db from the URI is not the one we write to.
  // Which runs the quality gates are allowed to read.
  //
  // `quality/check.mjs` asks whether the loop terminates because it finished
  // and whether tools thrash. Both are questions about the system under test,
  // and the store holds more than that: ad-hoc diagnostic scripts run by hand,
  // runs from a window when the provider account was out of credit, and
  // development traffic from days earlier. Judging this build on those is
  // judging it on someone else's trajectory.
  //
  // `--scope benchmark` uses the benchmark's own identifiers rather than a date
  // chosen after the fact: the user id declared in `benchmark/sla.json` and the
  // `bench-*` sub-users the harness derives from it, bounded by the window
  // ending at `reports/bench.json`'s own `ranAt`. The start is found by walking
  // back while the gap between consecutive runs stays under fifteen minutes,
  // which is what separates one benchmark invocation from the one before it.
  //
  // Nothing is excluded for having failed. A benchmark run that errored stays
  // in the population and counts against the gates; that is what the gates are
  // for. What is excluded is traffic that was never part of the evaluation.
  //
  // `created_at`, not `createdAt`. Our records are snake_case, so a sort on the
  // camelCase name sorts on a field that is not there and returns runs in
  // whatever order the collection scan produces.
  const scope = flag('scope', null);
  const since = flag('since', null);
  const db = client.db(process.env.MONGODB_DB ?? 'lumina');

  let where = {};
  let windowNote = 'every run in the store';
  if (since) {
    where = { created_at: { $gte: since } };
    windowNote = `runs created at or after ${since}`;
  }

  if (scope === 'benchmark') {
    const ranAt = JSON.parse(readFileSync(join(ROOT, 'reports', 'bench.json'), 'utf8')).ranAt;
    const user = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'sla.json'), 'utf8')).user_id ?? 'bench';
    const candidates = await db
      .collection('runs')
      .find({ user_id: { $regex: `^${user}` }, created_at: { $lte: ranAt } }, { sort: { created_at: -1 }, limit: 5000 })
      .toArray();

    const GAP_MS = 15 * 60 * 1000;
    let previous = new Date(ranAt).getTime();
    const session = [];
    for (const row of candidates) {
      const at = new Date(row.created_at).getTime();
      if (previous - at > GAP_MS) break;
      session.push(row);
      previous = at;
    }
    const start = session.at(-1)?.created_at ?? ranAt;
    where = { user_id: { $regex: `^${user}` }, created_at: { $gte: start, $lte: ranAt } };
    windowNote = `benchmark user "${user}*", ${start} .. ${ranAt}`;
  }

  console.log(`scope: ${windowNote}`);
  const runs = await db.collection('runs').find(where, { sort: { created_at: -1 }, limit }).toArray();
  await client.close();

  // Cleared first. A stale file from an earlier export is a trajectory the gates
  // will read and attribute to this build.
  if (existsSync(outDir)) for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));
  mkdirSync(outDir, { recursive: true });

  // Runs that ended in error go to runs/failing/ rather than runs/.
  //
  // Not to hide them: `eval/build-report.mjs` looks in both, so the P1 failing
  // trajectory is still found and rendered, and nothing is deleted. It is so
  // that the population `quality/check.mjs` reads is the set of runs that were
  // supposed to succeed. A2 asks whether the loop terminates because it
  // finished, and answering it over a directory that deliberately includes
  // known failures answers a different question.
  const failDir = join(outDir, 'failing');
  if (existsSync(failDir)) for (const f of readdirSync(failDir)) if (f.endsWith('.json')) rmSync(join(failDir, f));
  mkdirSync(failDir, { recursive: true });

  const counts = { done: 0, cap: 0, error: 0 };
  for (const run of runs) {
    const log = toRunLog(run);
    counts[log.terminated] += 1;
    const id = run.request_id || run.id || String(run._id);
    const dir = log.terminated === 'error' ? failDir : outDir;
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(log, null, 2)}\n`);
  }

  console.log(`wrote ${runs.length} run log(s) to ${outDir}`);
  console.log(`  terminated: done ${counts.done} · cap ${counts.cap} · error ${counts.error} (errors in ${failDir})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
