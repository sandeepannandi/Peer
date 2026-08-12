import type { InstallationOctokit } from './auth.js';

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullRequest {
  title: string;
  body: string | null;
  baseRef: string;
  headSha: string;
  /** Raw unified diff (Accept: application/vnd.github.diff). */
  diff: string;
  files: PrFile[];
}

export async function fetchPr(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  const endpoint = { owner, repo, pull_number: prNumber };

  const [pr, diffRes, files, commits] = await Promise.all([
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', endpoint),
    // With the .diff accept header the body is raw unified diff text, not JSON.
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...endpoint,
      headers: { accept: 'application/vnd.github.diff' },
    }),
    octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      ...endpoint,
      per_page: 100,
    }),
    octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      ...endpoint,
      per_page: 100,
    }),
  ]);

  const head = commits[commits.length - 1];
  if (!head) {
    throw new Error(`Pull request #${prNumber} has no commits.`);
  }

  return {
    title: pr.data.title,
    body: pr.data.body,
    baseRef: pr.data.base.ref,
    headSha: head.sha,
    diff: diffRes.data as unknown as string,
    files: files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    })),
  };
}
