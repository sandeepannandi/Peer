import type { InstallationOctokit } from '../github/auth.js';
import { recordReview, reviewPosted, type Db } from '../store/db.js';
import type { ReviewComment } from './format.js';

export class AmbiguousReviewPostError extends Error {}
export class StaleReviewError extends Error {}

export interface PostReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  comments: ReviewComment[];
  assertOwnership?: () => void;
}
export interface PostReviewResult {
  posted: boolean;
  reviewId?: number;
}

/** Atomic claim before a remote write. Ambiguous writes are NEVER automatically repeated. */
export async function postReview(
  octokit: InstallationOctokit,
  db: Db,
  options: PostReviewOptions,
): Promise<PostReviewResult> {
  const { owner, repo, prNumber, headSha, event, body, comments } = options;
  const key = [owner, repo, prNumber, headSha];
  if (reviewPosted(db, owner, repo, prNumber, headSha)) return { posted: false };
  const existing = db
    .prepare(
      `SELECT state FROM review_posts
    WHERE owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
    )
    .get(...key) as { state: string } | undefined;
  if (existing) {
    if (existing.state === 'posted') return { posted: false };
    throw new AmbiguousReviewPostError(
      'A review post is in-flight or ambiguous; operator reconciliation required.',
    );
  }
  const current = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: prNumber,
  });
  if (current.data.state !== 'open' || current.data.head.sha !== headSha) {
    throw new StaleReviewError('PR closed or head changed; stale review will not be posted.');
  }
  // Fencing check and claim are synchronous: no await between ownership and reservation.
  options.assertOwnership?.();
  const claimed = db
    .prepare(
      `INSERT INTO review_posts (owner, repo, pr_number, head_sha, state)
    VALUES (?, ?, ?, ?, 'uncertain') ON CONFLICT DO NOTHING`,
    )
    .run(...key).changes;
  if (!claimed) throw new AmbiguousReviewPostError('Another caller claimed this review post.');

  try {
    const res = await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event,
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      // Octokit's retry/throttling plugins must not repeat a non-idempotent POST.
      request: { retries: 0 },
    });
    db.transaction(() => {
      recordReview(db, owner, repo, prNumber, headSha, res.data.state, body);
      db.prepare(
        `UPDATE review_posts SET state = 'posted', review_id = ?
        WHERE owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
      ).run(Number(res.data.id), ...key);
    }).immediate();
    return { posted: true, reviewId: Number(res.data.id) };
  } catch {
    // The remote request may have succeeded even when its response was lost.
    // Preserve the claim across restarts; never infer it is safe to resend.
    throw new AmbiguousReviewPostError(
      'Review creation outcome is uncertain; operator reconciliation required.',
    );
  }
}
