import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export interface ReviewJobInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
}
export interface ReviewJob extends ReviewJobInput {
  id: number;
  attempts: number;
  state: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'superseded';
  lastError: string | null;
}

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

export function initializeJobs(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_jobs (
      id INTEGER PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, last_error TEXT,
      UNIQUE(owner, repo, pr_number, head_sha)
    );
    CREATE TABLE IF NOT EXISTS review_worker (
      id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_posts (
      owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
      state TEXT NOT NULL, review_id INTEGER,
      PRIMARY KEY(owner, repo, pr_number, head_sha)
    );
  `);
}

export function enqueueReview(db: Db, job: ReviewJobInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO review_jobs (owner, repo, pr_number, head_sha, delivery_id, available_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(job.owner, job.repo, job.prNumber, job.headSha, job.deliveryId, now);
}

export function listJobs(db: Db): ReviewJob[] {
  return db
    .prepare(
      `SELECT id, owner, repo, pr_number AS prNumber, head_sha AS headSha,
    delivery_id AS deliveryId, state, attempts, last_error AS lastError
    FROM review_jobs ORDER BY id DESC LIMIT 100`,
    )
    .all() as ReviewJob[];
}

/** One worker for the shared mirror/index as well as the queue, across processes. */
export function claimJob(db: Db, now = Date.now()): { token: string; job: ReviewJob } | null {
  return db
    .transaction(() => {
      const lock = db.prepare('SELECT expires_at FROM review_worker WHERE id = 1').get() as
        | { expires_at: number }
        | undefined;
      if (lock && lock.expires_at > now) return null;
      db.prepare(
        `UPDATE review_jobs SET state = CASE WHEN EXISTS (SELECT 1 FROM review_posts p WHERE p.owner = review_jobs.owner
          AND p.repo = review_jobs.repo AND p.pr_number = review_jobs.pr_number AND p.head_sha = review_jobs.head_sha
          AND p.state = 'uncertain') THEN 'blocked' WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
      last_error = 'Worker lease expired', available_at = ? WHERE state = 'running'`,
      ).run(MAX_ATTEMPTS, now);
      const row = db
        .prepare(
          `SELECT id FROM review_jobs WHERE state = 'pending' AND available_at <= ?
      ORDER BY id LIMIT 1`,
        )
        .get(now) as { id: number } | undefined;
      if (!row) {
        db.prepare('DELETE FROM review_worker WHERE id = 1').run();
        return null;
      }
      const token = randomUUID();
      db.prepare(
        `INSERT INTO review_worker (id, token, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
      ).run(token, now + LEASE_MS);
      db.prepare(
        "UPDATE review_jobs SET state = 'running', attempts = attempts + 1 WHERE id = ?",
      ).run(row.id);
      const job = db
        .prepare(
          `SELECT id, owner, repo, pr_number AS prNumber, head_sha AS headSha,
      delivery_id AS deliveryId, state, attempts, last_error AS lastError FROM review_jobs WHERE id = ?`,
        )
        .get(row.id) as ReviewJob | undefined;
      if (!job) throw new Error('Claimed job was not found.');
      return { token, job };
    })
    .immediate();
}

export function renewLease(db: Db, token: string, now = Date.now()): boolean {
  return (
    db
      .prepare(
        'UPDATE review_worker SET expires_at = ? WHERE id = 1 AND token = ? AND expires_at > ?',
      )
      .run(now + LEASE_MS, token, now).changes === 1
  );
}

export function assertLease(db: Db, token: string, now = Date.now()): void {
  const row = db
    .prepare('SELECT 1 FROM review_worker WHERE id = 1 AND token = ? AND expires_at > ?')
    .get(token, now);
  if (!row) throw new Error('Worker lease lost; refusing to post.');
}

export function finishJob(
  db: Db,
  token: string,
  job: ReviewJob,
  outcome: 'done' | 'retry' | 'blocked' | 'superseded',
  error: string | null = null,
  now = Date.now(),
): void {
  db.transaction(() => {
    assertLease(db, token, now);
    const state =
      outcome === 'retry' ? (job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending') : outcome;
    db.prepare(
      'UPDATE review_jobs SET state = ?, available_at = ?, last_error = ? WHERE id = ?',
    ).run(state, now + 30_000 * 2 ** (job.attempts - 1), error, job.id);
    db.prepare('DELETE FROM review_worker WHERE id = 1 AND token = ?').run(token);
  }).immediate();
}
