import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { newId } from '../shared/ids.js';
import { jobQueue } from './services/jobs.js';
import { indexDocumentJob } from './services/ingest.js';
import { pingMongo, mongoEnabled, closeMongo } from './store/mongo.js';

/**
 * The background worker.
 *
 * A separate process with no HTTP listener. It claims durable jobs, renews its
 * lease while it works, and finalises them. Nothing here is reachable from the
 * public internet, and the request path no longer does any of it.
 *
 * Runs from the same image as the Agent - same code, same provider credentials,
 * different entry point - so it is a Fly process group rather than a second
 * application to keep in step.
 */

const log = createLogger('worker');
const WORKER_ID = `${process.env.FLY_MACHINE_ID || 'local'}:${newId('wk')}`;
const TYPES = ['index_document'];
const LEASE_MS = Number(process.env.JOB_LEASE_MS || 60_000);
const IDLE_MS = Number(process.env.JOB_POLL_MS || 2_000);

let stopping = false;

/** Keep the lease alive for as long as the work takes. */
function heartbeat(jobId) {
  const timer = setInterval(() => {
    jobQueue.renew(jobId, { workerId: WORKER_ID, leaseMs: LEASE_MS }).catch((err) => {
      log.warn('lease_renew_failed', { job_id: jobId, err: err.message });
    });
  }, Math.max(1000, Math.floor(LEASE_MS / 3)));
  timer.unref?.();
  return () => clearInterval(timer);
}

const HANDLERS = {
  index_document: (payload, ctx) => indexDocumentJob(payload, ctx),
};

async function runOne(job) {
  const stop = heartbeat(job.id);
  const started = Date.now();
  try {
    const handler = HANDLERS[job.type];
    if (!handler) throw new Error(`no handler for job type ${job.type}`);
    const result = await handler(job.payload, {
      progress: async (progress, stage) => {
        await jobQueue.update(job.id, { progress: Number(Number(progress).toFixed(3)), ...(stage ? { stage } : {}) });
      },
    });
    await jobQueue.complete(job.id, result ?? null);
    log.info('job_done', { job_id: job.id, type: job.type, worker: WORKER_ID, ms: Date.now() - started });
  } catch (err) {
    // `fail` decides whether attempts remain; an exhausted job becomes failed
    // with the reason kept rather than being requeued forever.
    const after = await jobQueue.fail(job.id, err);
    log.error('job_failed', {
      job_id: job.id, type: job.type, worker: WORKER_ID, ms: Date.now() - started,
      err: err.message, status: after?.status, attempts: after?.attempts,
    });
  } finally {
    stop();
  }
}

export async function workerLoop({ once = false } = {}) {
  while (!stopping) {
    let job = null;
    try {
      job = await jobQueue.claimNext({ types: TYPES, workerId: WORKER_ID, leaseMs: LEASE_MS });
    } catch (err) {
      log.error('claim_failed', { err: err.message });
    }
    if (job) await runOne(job);
    else if (once) return;
    else await new Promise((r) => setTimeout(r, IDLE_MS));
    if (once) return;
  }
}

async function main() {
  log.info('worker_starting', {
    worker: WORKER_ID,
    store: mongoEnabled() ? 'mongodb' : 'json',
    mongo: mongoEnabled() ? await pingMongo() : 'n/a',
    types: TYPES,
    lease_ms: LEASE_MS,
    data_dir: config.agent.dataDir,
  });

  // Jobs abandoned by a machine that died come back; queued work is untouched.
  const requeued = await jobQueue.reconcile().catch((err) => {
    log.warn('reconcile_failed', { err: err.message });
    return 0;
  });
  if (requeued) log.info('worker_reconciled', { jobs: requeued });

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('worker_stopping', { signal, worker: WORKER_ID });
    // The lease is what protects in-flight work: stop renewing and another
    // worker picks it up when it lapses, rather than two running at once.
    await closeMongo().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await workerLoop();
}

if (process.argv[1] && process.argv[1].endsWith('worker.js')) await main();
