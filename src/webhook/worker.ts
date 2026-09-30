import { AmbiguousReviewPostError, StaleReviewError } from '../review/post.js';
import type { Db } from '../store/db.js';
import { assertLease, claimJob, finishJob, renewLease, type ReviewJob } from '../store/jobs.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger();
export type JobHandler = (job: ReviewJob, assertOwnership: () => void) => Promise<unknown>;

export async function runNextJob(db: Db, handler: JobHandler): Promise<boolean> {
  const claim = claimJob(db);
  if (!claim) return false;
  const { token, job } = claim;
  let lostLease = false;
  const heartbeat = setInterval(() => {
    try {
      if (!renewLease(db, token)) lostLease = true;
    } catch {
      lostLease = true;
    }
  }, 10_000);
  heartbeat.unref();
  const assertOwnership = () => {
    if (lostLease) throw new Error('Worker lease lost; refusing to post.');
    assertLease(db, token);
  };
  try {
    await handler(job, assertOwnership);
    finishJob(db, token, job, 'done');
  } catch (error) {
    logger.error(
      { jobId: job.id, attempts: job.attempts, error: String(error) },
      'queued review failed',
    );
    try {
      finishJob(
        db,
        token,
        job,
        error instanceof AmbiguousReviewPostError
          ? 'blocked'
          : error instanceof StaleReviewError
            ? 'superseded'
            : 'retry',
        error instanceof Error ? error.message.slice(0, 1000) : 'Review failed',
      );
    } catch {
      // A newer worker owns the lease. It alone may recover or finish this job.
      logger.warn({ jobId: job.id }, 'worker lease lost; job left for recovery');
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

/** Serialized draining. The SQLite lease also prevents a second process from draining. */
export function startJobWorker(db: Db, handler: JobHandler): { stop: () => Promise<void> } {
  let stopped = false;
  let current: Promise<void> | undefined;
  const tick = () => {
    if (stopped || current) return;
    current = (async () => {
      while (!stopped && (await runNextJob(db, handler))) {
        /* drain ready jobs */
      }
    })()
      .catch((error: unknown) => logger.error({ error: String(error) }, 'queue worker failed'))
      .finally(() => {
        current = undefined;
      });
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
