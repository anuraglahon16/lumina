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
    const { items } = await jobs.list({ status: { $in: ['running', 'queued'] } }, { limit: 1000 });
    for (const job of items) {
      if (instanceId && job.instance_id && job.instance_id !== instanceId) continue;
      await jobs.patch(job.id, {
        status: 'failed',
        error: 'interrupted by service restart',
        ended_at: new Date().toISOString(),
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
    });
    this.queue.push(job.id);
    this.emit('update', job);
    setImmediate(() => this.#pump());
    return job;
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
