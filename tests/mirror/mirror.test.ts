import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationOctokit } from '../../src/github/auth.js';
import { mirrorOrgRepos, mirrorRepo } from '../../src/mirror/mirror.js';
import { listReposByOwner, openDb, type Db } from '../../src/store/db.js';
import { runGit } from '../../src/util/exec.js';

const toPosix = (p: string): string => p.replace(/\\/g, '/');

let root: string;
let remoteRoot: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-mirror-'));
  remoteRoot = join(root, 'remotes');
  mkdirSync(remoteRoot, { recursive: true });
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Create a real local git repo with an initial commit on `main`. */
async function makeRemoteRepo(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(remoteRoot, name);
  mkdirSync(dir, { recursive: true });
  await runGit(['init', '-b', 'main', dir]);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  await runGit(['-C', dir, 'add', '.']);
  await runGit([
    '-C',
    dir,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);
  return dir;
}

describe('mirrorRepo', () => {
  it('clones, strips the token from origin, and refreshes on new commits', async () => {
    const remote = await makeRemoteRepo('app', { 'a.ts': 'export const A = 1;\n' });
    const mirrorRoot = join(root, 'mirror');
    const options = {
      owner: 'acme',
      name: 'app',
      defaultBranch: 'main',
      token: 'secret-token',
      mirrorRoot,
      remote: toPosix(remote),
    };

    const first = await mirrorRepo(options);
    expect(first.cloned).toBe(true);

    const target = join(mirrorRoot, 'acme', 'app');
    expect(existsSync(join(target, 'a.ts'))).toBe(true);
    // The token must never persist in the mirror's git config.
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('secret-token');

    // New upstream commit, then refresh.
    writeFileSync(join(remote, 'b.ts'), 'export const B = 2;\n');
    await runGit(['-C', remote, 'add', '.']);
    await runGit([
      '-C',
      remote,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'second',
    ]);

    const second = await mirrorRepo(options);
    expect(second.cloned).toBe(false);
    expect(existsSync(join(target, 'b.ts'))).toBe(true);
  });
});

describe('mirrorOrgRepos', () => {
  it('mirrors org repos, skips branchless ones, filters other owners, records in the DB', async () => {
    await makeRemoteRepo('api', { 'index.ts': 'export const api = 1;\n' });
    await makeRemoteRepo('web', { 'app.ts': 'export const web = 1;\n' });

    const octokit = {
      paginate: async () => [
        { name: 'api', default_branch: 'main', owner: { login: 'acme' } },
        { name: 'web', default_branch: null, owner: { login: 'acme' } },
        { name: 'intruder', default_branch: 'main', owner: { login: 'other-org' } },
      ],
    } as unknown as InstallationOctokit;

    const mirrorRoot = join(root, 'mirror');
    const result = await mirrorOrgRepos({
      octokit,
      token: 'secret-token',
      owner: 'acme',
      mirrorRoot,
      db,
      remoteFor: (repo) => toPosix(join(remoteRoot, repo.name)),
    });

    expect(result.mirrored.map((r) => r.name)).toEqual(['api']);
    expect(result.skipped).toEqual(['acme/web']);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(mirrorRoot, 'acme', 'api', 'index.ts'))).toBe(true);
    expect(listReposByOwner(db, 'acme').map((r) => r.name)).toEqual(['api']);
  });
});
