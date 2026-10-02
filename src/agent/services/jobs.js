import { EventEmitter } from 'node:events';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { createLogger } from '../../shared/logger.js';
import { compact } from '../store/filter.js';

const log = createLogger('jobs');
const jobs = collection('jobs');

/**
 * In-process background job queue: bounded concurrency, retries with backoff,
 * durable status records, and an event bus so SSE endpoints can watch a job.
 * One process only. A multi-instance deployment would swap this for Redis/BullMQ,
 * which is why every handler is registered by name rather than by closure.
 */
class JobQueue extends EventEmitter {

  constructor({ concurrency = 2 } = {}) {
    super();
    this.concurrency = concurrency;
    this.handlers = new Map();
    this.queue = [];
    this.running = 0;
    this.setMaxListeners(0);

  }

  /**
   * Anything left "running" from a previous process crashed; mark it honestly.
   *
   * Called after construction rather than inside it, because the store is async
   * and a constructor cannot await. With a shared database this is also no
   * longer purely local bookkeeping: another live instance may own those jobs,
   * so only this instance's are reconciled.
   */
  async reconcile(instanceId) {
    /**
     * Only `running` jobs, and only ones whose lease has lapsed.
     *
     * This used to sweep `queued` as well, which was defensible when the queue
     * was an in-process array - anything queued had no one to run it. Now a
     * queued job is durable work waiting for any worker, and failing it on
     * restart destroys exactly the thing the queue exists to protect. A
     * running job with a live lease belongs to a worker that is still alive,
     * so it is left alone too.
     */
    const { items: running } = await jobs.list({ status: 'running' }, { limit: 1000 });
    const now = Date.now();
    const items = running.filter((job) => {
      const until = job.lease_until ? Date.parse(job.lease_until) : 0;
      return !job.lease_until || Number.isNaN(until) || until <= now;
    });
    for (const job of items) {
      if (instanceId && job.instance_id && job.instance_id !== instanceId) continue;
      const attempts = job.attempts ?? 0;
      const exhausted = attempts >= (job.max_attempts ?? 1);
      await jobs.patch(job.id, {
        status: exhausted ? 'failed' : 'queued',
        stage: exhausted ? 'failed' : 'requeued',
        error: 'interrupted by service restart',
        worker_id: null,
        lease_until: null,
        ...(exhausted ? { ended_at: new Date().toISOString() } : {}),
      });
    }
    return items.length;
  }

  register(type, handler) {
    this.handlers.set(type, handler);
  }

  async enqueue(type, payload, { maxAttempts = 2, userId = null } = {}) {
    const job = await jobs.put({
      id: newId('job'),
      type,
      payload,
      user_id: userId,
      status: 'queued',
      progress: 0,
      stage: 'queued',
      attempts: 0,
      max_attempts: maxAttempts,
      result: null,
      error: null,
      started_at: null,
      ended_at: null,
      // A claim is `queued -> running` plus a lease. A worker that dies stops
      // renewing and the job comes back when the lease expires; a worker that
      // is merely slow keeps renewing and keeps the job.
      worker_id: null,
      lease_until: null,
    });
    // Flushed before the caller is told the job exists. The local store
    // debounces writes by 120ms, so a job enqueued and then lost to a restart
    // inside that window was never durable - and "durable job created before
    // the 202" is the whole promise this queue is making. Mongo writes
    // immediately and has no flush to call.
    await jobs.flush?.();
    this.emit('update', job);
    /**
     * Deliberately not started here.
     *
     * `enqueue` used to `setImmediate(() => this.#pump())`, so the process that
     * accepted the upload also parsed, chunked and embedded it. That is the
     * request path doing the worker's job: on a serverless function it was the
     * only way indexing ever happened, and everywhere else it meant an HTTP
     * handler holding a PDF parser open.
     *
     * A job now exists durably and waits to be claimed. The worker claims it.
     */
    return job;
  }

  /**
   * Take one queued job of the given types, atomically.
   *
   * There was no claim before: `enqueue` pushed an id onto an in-process array
   * and whoever enqueued it also ran it. That works only while there is one
   * process and it outlives the response, and the architecture this serves has
   * neither - the worker is a different process on a different machine.
   *
   * Serialised through `#claimChain` because the local JSON store has no
   * conditional update. Under Mongo the same guarantee comes from the store's
   * own atomic patch; the chain makes the two behave alike, and the property
   * the tests pin is that eight simultaneous callers produce exactly one
   * winner.
   */
  async claimNext({ types, workerId, leaseMs = 60_000 } = {}) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const patch = {
      status: 'running',
      worker_id: workerId ?? null,
      lease_until: new Date(now + leaseMs).toISOString(),
      started_at: nowIso,
      stage: 'claimed',
    };

    /**
     * One conditional write, pushed down to the store.
     *
     * This used to list the oldest 500 jobs of any status, pick a candidate in
     * JavaScript, then patch it. Two defects, both real:
     *
     * - Read-then-write is not a claim. Serialising inside one process made the
     *   single-process test pass and proved nothing about two: both workers saw
     *   the same queued row, both patched it to running, and both ran the job.
     *   The lease guards a later claim, never a concurrent one.
     * - The scan asked for 500 rows of *any* status, oldest first. Once 500 jobs
     *   existed - and most of them finished - the window held only completed
     *   work and newly queued jobs were never seen. The queue stopped draining,
     *   silently.
     *
     * The filter now selects only claimable rows, and the store performs the
     * match and the write together: `findOneAndUpdate` under Mongo, a serialised
     * chain under the local JSON store where there is only one process anyway.
     */
    const claimable = {
      type: { $in: types ?? [] },
      $or: [
        { status: 'queued' },
        // A running job whose lease has lapsed is abandoned, not owned.
        { status: 'running', lease_until: { $lte: nowIso } },
      ],
    };

    const claimed = await jobs.claimOne(claimable, patch, { sortKey: 'created_at' });
    if (claimed) this.emit('update', claimed);
    return claimed ?? null;
  }

  /** Extend the lease on a job this worker still owns. */
  async renew(jobId, { workerId, leaseMs = 60_000 } = {}) {
    const job = await jobs.get(jobId);
    if (!job || job.worker_id !== workerId) return null;
    return this.update(jobId, { lease_until: new Date(Date.now() + leaseMs).toISOString() });
  }

  /** The work succeeded. */
  async complete(jobId, result = null) {
    return this.update(jobId, {
      status: 'done',
      progress: 1,
      stage: 'done',
      result,
      error: null,
      lease_until: null,
      ended_at: new Date().toISOString(),
    });
  }

  /**
   * The work threw. Back to the queue if attempts remain, otherwise failed
   * with the reason kept - a job that has run out of attempts must not look
   * like one still waiting its turn.
   */
  async fail(jobId, err) {
    const job = await jobs.get(jobId);
    if (!job) return null;
    const attempts = (job.attempts ?? 0) + 1;
    const message = err?.message ? String(err.message) : String(err);
    if (attempts < (job.max_attempts ?? 1)) {
      return this.update(jobId, {
        status: 'queued',
        attempts,
        stage: 'retrying',
        error: message,
        worker_id: null,
        lease_until: null,
      });
    }
    return this.update(jobId, {
      status: 'failed',
      attempts,
      stage: 'failed',
      error: message,
      worker_id: null,
      lease_until: null,
      ended_at: new Date().toISOString(),
    });
  }

  /**
   * Run a job in this process, on purpose.
   *
   * The single-function deployment freezes once it responds, so it has no
   * worker to hand the job to and must run it inline. That is a property of
   * that platform, not of the queue, so it says so at the call site instead of
   * being the default everywhere.
   */
  async runNow(jobId) {
    return this.#run(jobId);
  }

  async update(jobId, patch) {
    const job = await jobs.patch(jobId, patch);
    if (job) this.emit('update', job);
    return job;
  }

  async get(jobId) {
    return jobs.get(jobId);
  }

  async list(filter = {}, opts = {}) {
    return jobs.list(compact({ user_id: filter.userId, type: filter.type }), opts);
  }

  /**
   * Wait for one job to leave the queue.
   *
   * Only needed where the process cannot outlive its response. Elsewhere the
   * whole point of the queue is that the caller does not wait.
   */
  async drain(jobId, { timeoutMs = 280_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await jobs.get(jobId);
      if (!job || ['completed', 'failed'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 200));
    }
    return jobs.get(jobId);
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const jobId = this.queue.shift();
      this.running += 1;
      this.#run(jobId).finally(() => {
        this.running -= 1;
        this.#pump();
      });
    }
  }

  async #run(jobId) {
    const job = await jobs.get(jobId);
    if (!job) return;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.update(jobId, { status: 'failed', error: `no handler for job type ${job.type}`, ended_at: new Date().toISOString() });
      return;
    }

    const started = performance.now();
    await this.update(jobId, { status: 'running', attempts: job.attempts + 1, started_at: new Date().toISOString(), stage: 'starting' });

    const ctx = {
      jobId,
      progress: (progress, stage) => this.update(jobId, { progress: Number(progress.toFixed(3)), ...(stage ? { stage } : {}) }),
      log: log.child({ job_id: jobId, type: job.type }),
    };

    try {
      const result = await handler(job.payload, ctx);
      await this.update(jobId, {
        status: 'completed',
        progress: 1,
        stage: 'done',
        result: result ?? null,
        error: null,
        ended_at: new Date().toISOString(),
        duration_ms: Math.round(performance.now() - started),
      });
      log.info('job_completed', { job_id: jobId, type: job.type, duration_ms: Math.round(performance.now() - started) });
    } catch (err) {
      const current = await jobs.get(jobId);
      const canRetry = current.attempts < current.max_attempts;
      log.error('job_failed', { job_id: jobId, type: job.type, attempt: current.attempts, err: err.message, will_retry: canRetry });
      if (canRetry) {
        await this.update(jobId, { status: 'queued', stage: 'retrying', error: err.message });
        const delay = 1000 * 2 ** current.attempts;
        setTimeout(() => {
          this.queue.push(jobId);
          this.#pump();
        }, delay).unref?.();
      } else {
        await this.update(jobId, {
          status: 'failed',
          error: err.message,
          ended_at: new Date().toISOString(),
          duration_ms: Math.round(performance.now() - started),
        });
      }
    }
  }
}

export const jobQueue = new JobQueue({ concurrency: Number(process.env.JOB_CONCURRENCY || 2) });
