import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationOctokit } from '../../src/github/auth.js';
import { postReview } from '../../src/review/post.js';
import { openDb, reviewPosted, type Db } from '../../src/store/db.js';

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-post-'));
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function stubOctokit() {
  return {
    request: vi.fn(async () => ({ data: { id: 77, state: 'COMMENTED' } })),
  } as unknown as InstallationOctokit;
}

const options = {
  owner: 'acme',
  repo: 'api',
  prNumber: 42,
  headSha: 'abc123',
  event: 'REQUEST_CHANGES',
  body: 'Summary',
  comments: [{ path: 'src/api.ts', line: 2, side: 'RIGHT', body: 'Comment' }],
} as const;

describe('postReview', () => {
  it('posts the review with inline comments and records it in the DB', async () => {
    const octokit = stubOctokit();
    const result = await postReview(octokit, db, options);

    expect(result).toEqual({ posted: true, reviewId: 77 });
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      {
        owner: 'acme',
        repo: 'api',
        pull_number: 42,
        commit_id: 'abc123',
        event: 'REQUEST_CHANGES',
        body: 'Summary',
        comments: [{ path: 'src/api.ts', line: 2, side: 'RIGHT', body: 'Comment' }],
      },
    );
    expect(reviewPosted(db, 'acme', 'api', 42, 'abc123')).toBe(true);
  });

  it('skips posting when a review already exists for the head commit (dedup)', async () => {
    const octokit = stubOctokit();
    await postReview(octokit, db, options);
    octokit.request.mockClear();

    const result = await postReview(octokit, db, options);

    expect(result).toEqual({ posted: false });
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it('posts again for a different head commit', async () => {
    const octokit = stubOctokit();
    await postReview(octokit, db, options);

    const result = await postReview(octokit, db, { ...options, headSha: 'def456' });

    expect(result.posted).toBe(true);
    expect(octokit.request).toHaveBeenCalledTimes(2);
    expect(reviewPosted(db, 'acme', 'api', 42, 'def456')).toBe(true);
  });
});
