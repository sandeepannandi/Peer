import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import {
  assertLease,
  claimJob,
  enqueueReview,
  finishJob,
  listJobs,
  renewLease,
} from '../../src/store/jobs.js';

let root: string;
let db: Db;
const input = {
  owner: 'acme',
  repo: 'api',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  deliveryId: 'one',
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-jobs-'));
  db = openDb(join(root, 'db'));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('durable jobs', () => {
  it('dedupes delivery and head, survives reopening an existing database', () => {
    enqueueReview(db, input, 0);
    enqueueReview(db, input, 0);
    enqueueReview(db, { ...input, deliveryId: 'two' }, 0);
    db.close();
    db = openDb(join(root, 'db'));
    expect(listJobs(db)).toHaveLength(1);
    expect(claimJob(db, 0)?.job).toMatchObject({
      attempts: 1,
      state: 'running',
      headSha: input.headSha,
    });
  });
  it('serializes two DB connections and fences an expired worker after restart', () => {
    enqueueReview(db, input, 0);
    const first = claimJob(db, 0)!;
    const second = openDb(join(root, 'db'));
    try {
      expect(claimJob(second, 1)).toBeNull();
      const recovery = claimJob(second, 60_001)!;
      expect(recovery.job.attempts).toBe(2);
      expect(renewLease(db, first.token, 60_001)).toBe(false);
      expect(() => assertLease(db, first.token, 60_001)).toThrow();
      expect(() => finishJob(db, first.token, first.job, 'done', null, 60_001)).toThrow();
      finishJob(second, recovery.token, recovery.job, 'done', null, 60_001);
      expect(listJobs(db)[0].state).toBe('done');
    } finally {
      second.close();
    }
  });
  it('backs off retries and reaches terminal failure after three attempts', () => {
    enqueueReview(db, input, 0);
    const first = claimJob(db, 0)!;
    finishJob(db, first.token, first.job, 'retry', 'temporary', 0);
    expect(claimJob(db, 29_999)).toBeNull();
    const second = claimJob(db, 30_000)!;
    finishJob(db, second.token, second.job, 'retry', 'temporary', 30_000);
    const third = claimJob(db, 90_000)!;
    finishJob(db, third.token, third.job, 'retry', 'permanent', 90_000);
    expect(listJobs(db)[0]).toMatchObject({ state: 'failed', attempts: 3, lastError: 'permanent' });
    expect(claimJob(db, 1_000_000)).toBeNull();
  });
  it('keeps ambiguous posting failures blocked rather than retrying', () => {
    enqueueReview(db, input, 0);
    const first = claimJob(db, 0)!;
    finishJob(db, first.token, first.job, 'blocked', 'uncertain', 0);
    expect(claimJob(db, 1_000_000)).toBeNull();
    expect(listJobs(db)[0].state).toBe('blocked');
  });
  it('blocks crash recovery when a durable post claim is uncertain', () => {
    enqueueReview(db, input, 0);
    const first = claimJob(db, 0)!;
    db.prepare(
      `INSERT INTO review_posts (owner, repo, pr_number, head_sha, state) VALUES (?, ?, ?, ?, 'uncertain')`,
    ).run(input.owner, input.repo, input.prNumber, input.headSha);
    expect(claimJob(db, 60_001)).toBeNull();
    expect(listJobs(db)[0].state).toBe('blocked');
    expect(() => assertLease(db, first.token, 60_001)).toThrow();
  });

  it('claims older ready jobs even with more than 100 jobs stored', () => {
    for (let i = 0; i < 110; i++)
      enqueueReview(db, { ...input, prNumber: i + 1, deliveryId: String(i) }, 0);
    expect(claimJob(db, 0)?.job.prNumber).toBe(1);
  });
});
