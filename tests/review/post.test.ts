import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationOctokit } from '../../src/github/auth.js';
import { postReview, AmbiguousReviewPostError, StaleReviewError } from '../../src/review/post.js';
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
    request: vi.fn(async (route: string) =>
      route.startsWith('GET')
        ? { data: { state: 'open', head: { sha: options.headSha } } }
        : { data: { id: 77, state: 'COMMENTED' } },
    ),
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
  it('permits only one POST across concurrent callers and DB connections', async () => {
    const second = openDb(join(root, 'index.db'));
    try {
      const octokit = stubOctokit();
      const results = await Promise.allSettled([
        postReview(octokit, db, options),
        postReview(octokit, second, options),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        octokit.request.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('POST')),
      ).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('preserves an ambiguous claim across restart and never reposts', async () => {
    const octokit = stubOctokit();
    octokit.request.mockImplementation(async (route: string) => {
      if (route.startsWith('GET'))
        return { data: { state: 'open', head: { sha: options.headSha } } };
      throw new Error('response lost');
    });
    await expect(postReview(octokit, db, options)).rejects.toBeInstanceOf(AmbiguousReviewPostError);
    db.close();
    db = openDb(join(root, 'index.db'));
    octokit.request.mockClear();
    await expect(postReview(octokit, db, options)).rejects.toBeInstanceOf(AmbiguousReviewPostError);
    expect(octokit.request).not.toHaveBeenCalled();
    expect(reviewPosted(db, 'acme', 'api', 42, 'abc123')).toBe(false);
  });

  it('does not POST a changed head or when the worker lost its lease', async () => {
    const octokit = stubOctokit();
    await expect(postReview(octokit, db, { ...options, headSha: 'old' })).rejects.toBeInstanceOf(
      StaleReviewError,
    );
    await expect(
      postReview(octokit, db, {
        ...options,
        assertOwnership: () => {
          throw new Error('lost lease');
        },
      }),
    ).rejects.toThrow('lost lease');
    expect(octokit.request.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('POST'))).toBe(
      false,
    );
  });

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
        request: { retries: 0 },
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

    octokit.request.mockImplementation(async (route: string) =>
      route.startsWith('GET')
        ? { data: { state: 'open', head: { sha: 'def456' } } }
        : { data: { id: 78, state: 'COMMENTED' } },
    );
    const result = await postReview(octokit, db, { ...options, headSha: 'def456' });

    expect(result.posted).toBe(true);
    expect(octokit.request).toHaveBeenCalledTimes(4);
    expect(reviewPosted(db, 'acme', 'api', 42, 'def456')).toBe(true);
  });
});
