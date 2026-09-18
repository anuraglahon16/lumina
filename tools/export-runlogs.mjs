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
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
const CAP_REASONS = new Set([
  'max_tool_calls_reached',
  'max_searches_reached',
  'max_fetches_reached',
  'max_iterations_reached',
  'wall_clock_exceeded',
  'retrieval_deadline',
  'budget_exhausted',
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
  // `--since` exists because these files are read as trajectories of the build
  // under test. A run from a window when the provider account was out of credit
  // is a trajectory of an outage, and sweeping it in attributes someone else's
  // failure to this code. Without the flag everything is exported, which is the
  // honest default; with it, say in the report which window was used and why.
  // `created_at`, not `createdAt`. Our records are snake_case, so a sort on the
  // camelCase name sorts on a field that is not there and returns runs in
  // whatever order the collection scan produces — which is how an export asking
  // for "the latest 300" came back with runs from three days earlier.
  const since = flag('since', null);
  const where = since ? { created_at: { $gte: since } } : {};
  const runs = await client
    .db(process.env.MONGODB_DB ?? 'lumina')
    .collection('runs')
    .find(where, { sort: { created_at: -1 }, limit })
    .toArray();
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
