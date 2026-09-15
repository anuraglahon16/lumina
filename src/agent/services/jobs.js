import { EventEmitter } from 'node:events';
import { newId } from '../../shared/ids.js';
import { collection } from '../store/jsonStore.js';
import { createLogger } from '../../shared/logger.js';

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

    // Anything left "running" from a previous process crashed; mark it honestly.
    for (const job of jobs.items.values()) {
      if (job.status === 'running' || job.status === 'queued') {
        jobs.patch(job.id, { status: 'failed', error: 'interrupted by service restart', ended_at: new Date().toISOString() });
      }
    }
  }

  register(type, handler) {
    this.handlers.set(type, handler);
  }

  enqueue(type, payload, { maxAttempts = 2, userId = null } = {}) {
    const job = jobs.put({
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

  update(jobId, patch) {
    const job = jobs.patch(jobId, patch);
    if (job) this.emit('update', job);
    return job;
  }

  get(jobId) {
    return jobs.get(jobId);
  }

  list(filter = {}, opts = {}) {
    return jobs.list((j) => (!filter.userId || j.user_id === filter.userId) && (!filter.type || j.type === filter.type), opts);
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
    const job = jobs.get(jobId);
    if (!job) return;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.update(jobId, { status: 'failed', error: `no handler for job type ${job.type}`, ended_at: new Date().toISOString() });
      return;
    }

    const started = performance.now();
    this.update(jobId, { status: 'running', attempts: job.attempts + 1, started_at: new Date().toISOString(), stage: 'starting' });

    const ctx = {
      jobId,
      progress: (progress, stage) => this.update(jobId, { progress: Number(progress.toFixed(3)), ...(stage ? { stage } : {}) }),
      log: log.child({ job_id: jobId, type: job.type }),
    };

    try {
      const result = await handler(job.payload, ctx);
      this.update(jobId, {
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
      const current = jobs.get(jobId);
      const canRetry = current.attempts < current.max_attempts;
      log.error('job_failed', { job_id: jobId, type: job.type, attempt: current.attempts, err: err.message, will_retry: canRetry });
      if (canRetry) {
        this.update(jobId, { status: 'queued', stage: 'retrying', error: err.message });
        const delay = 1000 * 2 ** current.attempts;
        setTimeout(() => {
          this.queue.push(jobId);
          this.#pump();
        }, delay).unref?.();
      } else {
        this.update(jobId, {
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
