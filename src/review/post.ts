import type { InstallationOctokit } from '../github/auth.js';
import { recordReview, reviewPosted, type Db } from '../store/db.js';
import type { ReviewComment } from './format.js';

export interface PostReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  comments: ReviewComment[];
}

export interface PostReviewResult {
  posted: boolean;
  reviewId?: number;
}

/** Post a PR review; skip silently when one already exists for this head commit. */
export async function postReview(
  octokit: InstallationOctokit,
  db: Db,
  options: PostReviewOptions,
): Promise<PostReviewResult> {
  const { owner, repo, prNumber, headSha, event, body, comments } = options;

  if (reviewPosted(db, owner, repo, prNumber, headSha)) {
    return { posted: false };
  }

  const res = await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event,
    body,
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
  });

  recordReview(db, owner, repo, prNumber, headSha, res.data.state, body);
  return { posted: true, reviewId: Number(res.data.id) };
}
