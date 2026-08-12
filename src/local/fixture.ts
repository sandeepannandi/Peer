import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRequest } from '../github/pr.js';
import { upsertRepo, type Db } from '../store/db.js';

/** Local fixture mode: mirrors static fixture dirs and loads PRs from disk. */

export function listLocalRepos(fixturesRoot: string): string[] {
  if (!existsSync(fixturesRoot)) {
    throw new Error(`Fixtures directory not found: ${fixturesRoot}`);
  }
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/** Copy each fixture repo into the mirror (static snapshots — no git needed) and record them in the DB. */
export function stageLocalRepos(options: {
  fixturesRoot: string;
  mirrorRoot: string;
  owner: string;
  db: Db;
}): string[] {
  const { fixturesRoot, mirrorRoot, owner, db } = options;
  const staged: string[] = [];
  for (const name of listLocalRepos(fixturesRoot)) {
    cpSync(join(fixturesRoot, name), join(mirrorRoot, owner, name), { recursive: true });
    upsertRepo(db, { owner, name, defaultBranch: 'main' });
    staged.push(name);
  }
  if (staged.length === 0) {
    throw new Error(`No fixture repos found in ${fixturesRoot}`);
  }
  return staged;
}

export interface LocalPrMeta {
  title?: string;
  body?: string | null;
  baseRef?: string;
  headSha?: string;
}

/** Load a PR from {fixturesRoot}/{repo}/prs/{n}.diff (+ optional .json metadata). */
export function loadLocalPr(fixturesRoot: string, repo: string, prNumber: number): PullRequest {
  const base = join(fixturesRoot, repo, 'prs', String(prNumber));
  const diffPath = `${base}.diff`;
  if (!existsSync(diffPath)) {
    throw new Error(`No local PR fixture at ${diffPath} — create ${repo}/prs/${prNumber}.diff`);
  }
  const meta: LocalPrMeta = existsSync(`${base}.json`)
    ? (JSON.parse(readFileSync(`${base}.json`, 'utf8')) as LocalPrMeta)
    : {};
  return {
    title: meta.title ?? `Local PR #${prNumber}`,
    body: meta.body ?? null,
    baseRef: meta.baseRef ?? 'main',
    headSha: meta.headSha ?? `local-${prNumber}`,
    diff: readFileSync(diffPath, 'utf8'),
    files: [],
  };
}
