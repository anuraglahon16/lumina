import fs from 'node:fs';
import path from 'node:path';
import { config, priceFor } from '../../shared/config.js';
import { newId } from '../../shared/ids.js';
import { collection } from './jsonStore.js';

const runs = collection('runs');

let appendStream = null;
function ndjson() {
  if (!appendStream) {
    fs.mkdirSync(path.dirname(config.logging.runLogFile), { recursive: true });
    appendStream = fs.createWriteStream(config.logging.runLogFile, { flags: 'a' });
  }
  return appendStream;
}

/**
 * Per-run observability record. Everything the assignment asks us to log,
 * latency, cost, tokens, tool calls, errors, cache behaviour, termination
 * reason, is accumulated here and written once at the end, plus appended to
 * an NDJSON file for offline analysis.
 */
export class RunRecorder {
  constructor({ requestId, userId, threadId, mode, query, model }) {
    this.run = {
      id: newId('run'),
      request_id: requestId,
      user_id: userId,
      thread_id: threadId || null,
      mode,
      query,
      model,
      status: 'running',
      started_at: new Date().toISOString(),
      ended_at: null,
      latency_ms: null,
      ttft_ms: null,
      phases: [],
      llm_calls: [],
      tool_calls: [],
      errors: [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: 0,
      cache: { hits: 0, misses: 0, writes: 0, by_namespace: {} },
      sources: { discovered: 0, fetched: 0, cited: 0 },
      citations: { emitted: 0, valid: 0, invalid: 0, groundedness: null },
      termination_reason: null,
      budget: null,
      answer_chars: 0,
    };
    this.t0 = performance.now();
    this.openPhases = new Map();
  }

  get id() {
    return this.run.id;
  }

  elapsedMs() {
    return Math.round(performance.now() - this.t0);
  }

  startPhase(name, meta = {}) {
    this.openPhases.set(name, { name, meta, t: performance.now() });
  }

  endPhase(name, meta = {}) {
    const open = this.openPhases.get(name);
    if (!open) return;
    this.openPhases.delete(name);
    this.run.phases.push({
      name,
      duration_ms: Math.round(performance.now() - open.t),
      started_at_ms: Math.round(open.t - this.t0),
      ...open.meta,
      ...meta,
    });
  }

  markFirstToken() {
    if (this.run.ttft_ms === null) this.run.ttft_ms = this.elapsedMs();
  }

  /** Accumulate token usage and price it with the model's published rates. */
  recordLlmCall({ model, purpose, usage, durationMs, stopReason }) {
    const input = usage?.input_tokens || 0;
    const output = usage?.output_tokens || 0;
    const cacheRead = usage?.cache_read_input_tokens || 0;
    const cacheWrite = usage?.cache_creation_input_tokens || 0;
    const p = priceFor(model);
    const cost =
      (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000;

    this.run.tokens.input += input;
    this.run.tokens.output += output;
    this.run.tokens.cache_read += cacheRead;
    this.run.tokens.cache_write += cacheWrite;
    this.run.cost_usd = Number((this.run.cost_usd + cost).toFixed(6));
    this.run.llm_calls.push({
      model,
      purpose,
      // Stamped like tool calls are, so a reconstructed trace can interleave
      // model calls and tool calls in the order they actually happened.
      at_ms: this.elapsedMs(),
      duration_ms: durationMs,
      stop_reason: stopReason,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      cost_usd: Number(cost.toFixed(6)),
    });
    return cost;
  }

  recordToolCall({ name, input, durationMs, ok, summary, error, cached, branch }) {
    this.run.tool_calls.push({
      seq: this.run.tool_calls.length + 1,
      name,
      branch: branch || null,
      input,
      duration_ms: durationMs,
      ok,
      cached: Boolean(cached),
      summary,
      error: error || null,
      at_ms: this.elapsedMs(),
    });
  }

  recordCache({ namespace, hit, write }) {
    const bucket = (this.run.cache.by_namespace[namespace] ||= { hits: 0, misses: 0, writes: 0 });
    if (write) {
      this.run.cache.writes += 1;
      bucket.writes += 1;
    } else if (hit) {
      this.run.cache.hits += 1;
      bucket.hits += 1;
    } else {
      this.run.cache.misses += 1;
      bucket.misses += 1;
    }
  }

  recordError(where, err) {
    this.run.errors.push({
      where,
      message: err?.message || String(err),
      type: err?.constructor?.name || 'Error',
      at_ms: this.elapsedMs(),
    });
  }

  set(patch) {
    Object.assign(this.run, patch);
  }

  finish({ status = 'ok', terminationReason, answer, citations, sources } = {}) {
    this.run.status = status;
    this.run.ended_at = new Date().toISOString();
    this.run.latency_ms = this.elapsedMs();
    if (terminationReason) this.run.termination_reason = terminationReason;
    if (answer !== undefined) this.run.answer_chars = answer?.length || 0;
    if (citations) this.run.citations = { ...this.run.citations, ...citations };
    if (sources) this.run.sources = { ...this.run.sources, ...sources };
    for (const name of [...this.openPhases.keys()]) this.endPhase(name, { unterminated: true });
    runs.put(this.run);
    ndjson().write(`${JSON.stringify(this.run)}\n`);
    return this.run;
  }

  snapshot() {
    return { ...this.run, latency_ms: this.elapsedMs() };
  }
}

export function getRun(id) {
  return runs.get(id);
}

export function listRuns(filter = {}, opts = {}) {
  return runs.list(
    (r) =>
      (!filter.userId || r.user_id === filter.userId) &&
      (!filter.mode || r.mode === filter.mode) &&
      (!filter.threadId || r.thread_id === filter.threadId),
    opts,
  );
}

/** Aggregate metrics across stored runs: the numbers you actually watch. */
export function runStats(filter = {}) {
  const { items } = listRuns(filter, { limit: 10000 });
  if (!items.length) return { runs: 0 };
  const pick = (f) => items.map(f).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
  const lat = pick((r) => r.latency_ms);
  const ttft = pick((r) => r.ttft_ms);
  const byTermination = {};
  const byMode = {};
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const r of items) {
    byTermination[r.termination_reason || 'unknown'] = (byTermination[r.termination_reason || 'unknown'] || 0) + 1;
    byMode[r.mode] = (byMode[r.mode] || 0) + 1;
    cacheHits += r.cache?.hits || 0;
    cacheMisses += r.cache?.misses || 0;
  }
  const sum = (f) => items.reduce((acc, r) => acc + (f(r) || 0), 0);
  return {
    runs: items.length,
    by_mode: byMode,
    by_termination_reason: byTermination,
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), max: lat[lat.length - 1] ?? null },
    ttft_ms: { p50: pct(ttft, 50), p95: pct(ttft, 95) },
    cost_usd: { total: Number(sum((r) => r.cost_usd).toFixed(4)), avg: Number((sum((r) => r.cost_usd) / items.length).toFixed(5)) },
    tokens: {
      input: sum((r) => r.tokens?.input),
      output: sum((r) => r.tokens?.output),
      cache_read: sum((r) => r.tokens?.cache_read),
      cache_write: sum((r) => r.tokens?.cache_write),
    },
    tool_calls: sum((r) => r.tool_calls?.length),
    errors: sum((r) => r.errors?.length),
    cache_hit_rate: cacheHits + cacheMisses ? Number((cacheHits / (cacheHits + cacheMisses)).toFixed(3)) : null,
  };
}
