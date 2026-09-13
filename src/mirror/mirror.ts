import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstallationOctokit } from '../github/auth.js';
import type { Db } from '../store/db.js';
import { upsertRepo } from '../store/db.js';
import { runGit } from '../util/exec.js';

export interface OrgRepo {
  name: string;
  default_branch: string | null;
}

export interface MirrorRepoOptions {
  owner: string;
  name: string;
  defaultBranch: string;
  token: string;
  mirrorRoot: string;
  /** Override the clone/fetch remote — used by tests and local mode. */
  remote?: string;
}

export interface MirrorRepoResult {
  cloned: boolean;
  branch: string;
}

export interface MirrorOrgReposOptions {
  octokit: InstallationOctokit;
  token: string;
  owner: string;
  mirrorRoot: string;
  db: Db;
  /** Override the git remote per repo — used by tests and local mode. */
  remoteFor?: (repo: OrgRepo) => string;
}

export interface MirrorOrgReposResult {
  mirrored: OrgRepo[];
  skipped: string[];
  failed: Array<{ repo: string; error: string }>;
}

function authUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

function cleanUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

export async function listOrgRepos(
  octokit: InstallationOctokit,
  owner: string,
): Promise<OrgRepo[]> {
  const repos = await octokit.paginate('GET /installation/repositories', { per_page: 100 });
  return repos
    .filter((repo) => repo.owner.login === owner)
    .map((repo) => ({ name: repo.name, default_branch: repo.default_branch ?? null }));
}

// Shallow clone (or refresh); the token is stripped from origin so it never persists.
export async function mirrorRepo(options: MirrorRepoOptions): Promise<MirrorRepoResult> {
  const { owner, name, defaultBranch, token, mirrorRoot, remote } = options;
  const target = join(mirrorRoot, owner, name);
  const remoteUrl = remote ?? authUrl(owner, name, token);

  if (existsSync(join(target, '.git'))) {
    await runGit(['-C', target, 'fetch', '--depth', '1', remoteUrl, defaultBranch], {
      redact: [token],
    });
    await runGit(['-C', target, 'reset', '--hard', 'FETCH_HEAD']);
    return { cloned: false, branch: defaultBranch };
  }

  mkdirSync(dirname(target), { recursive: true });
  await runGit(['clone', '--depth', '1', '--branch', defaultBranch, remoteUrl, target], {
    redact: [token],
  });
  try {
    // Strip credentials so the token never persists in .git/config.
    await runGit(['-C', target, 'remote', 'set-url', 'origin', cleanUrl(owner, name)]);
  } catch (err) {
    rmSync(target, { recursive: true, force: true }); // never leave a tokenized origin behind
    throw err;
  }
  return { cloned: true, branch: defaultBranch };
}

export async function mirrorOrgRepos(
  options: MirrorOrgReposOptions,
): Promise<MirrorOrgReposResult> {
  const { octokit, token, owner, mirrorRoot, db, remoteFor } = options;
  const repos = await listOrgRepos(octokit, owner);
  const result: MirrorOrgReposResult = { mirrored: [], skipped: [], failed: [] };

  for (const repo of repos) {
    const label = `${owner}/${repo.name}`;
    if (!repo.default_branch) {
      result.skipped.push(label);
      continue;
    }
    try {
      await mirrorRepo({
        owner,
        name: repo.name,
        defaultBranch: repo.default_branch,
        token,
        mirrorRoot,
        remote: remoteFor ? remoteFor(repo) : undefined,
      });
      upsertRepo(db, { owner, name: repo.name, defaultBranch: repo.default_branch });
      result.mirrored.push(repo);
    } catch (err) {
      result.failed.push({ repo: label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
