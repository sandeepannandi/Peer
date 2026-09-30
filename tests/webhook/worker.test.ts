import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmbiguousReviewPostError, StaleReviewError } from '../../src/review/post.js';
import { openDb, type Db } from '../../src/store/db.js';
import { enqueueReview, listJobs } from '../../src/store/jobs.js';
import { runNextJob } from '../../src/webhook/worker.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-worker-'));
  db = openDb(join(dir, 'db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const input = {
  owner: 'acme',
  repo: 'api',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  deliveryId: 'one',
};
describe('job worker', () => {
  it('runs persisted jobs and never overlaps concurrent ticks', async () => {
    enqueueReview(db, input);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const handler = vi.fn(async (_job, assertOwnership: () => void) => {
      assertOwnership();
      await gate;
    });
    const running = runNextJob(db, handler);
    expect(await runNextJob(db, handler)).toBe(false);
    unblock();
    await running;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(listJobs(db)[0].state).toBe('done');
  });
  it.each([
    [new Error('temporary'), 'pending'],
    [new AmbiguousReviewPostError('uncertain'), 'blocked'],
    [new StaleReviewError('old head'), 'superseded'],
  ])('classifies %s as %s', async (error, state) => {
    enqueueReview(db, input);
    await runNextJob(db, async () => {
      throw error;
    });
    expect(listJobs(db)[0].state).toBe(state);
  });
});
