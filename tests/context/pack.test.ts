import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildContextPack } from '../../src/context/pack.js';
import type { Probes } from '../../src/context/probes.js';
import { indexRepos } from '../../src/mirror/indexer.js';
import { openDb, upsertRepo, type Db } from '../../src/store/db.js';

let root: string;
let mirrorRoot: string;
let workspaceRoot: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-pack-'));
  mirrorRoot = join(root, 'mirror');
  workspaceRoot = join(root, 'workspace');
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function repoDir(repo: string): string {
  const dir = join(mirrorRoot, 'acme', repo);
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

function setup(): void {
  upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });
  upsertRepo(db, { owner: 'acme', name: 'web', defaultBranch: 'main' });
  upsertRepo(db, { owner: 'acme', name: 'shared', defaultBranch: 'main' });

  writeFileSync(join(repoDir('api'), 'src', 'client.ts'), 'export class UserClient {}\n');
  writeFileSync(join(repoDir('web'), 'src', 'api.ts'), 'export function getUsers() {}\n');
  writeFileSync(join(repoDir('web'), 'src', 'other.ts'), '// TODO: replace /api/v2/users\n');
  writeFileSync(join(repoDir('web'), 'README.md'), '# web\n');
  writeFileSync(join(repoDir('shared'), 'src', 'user-client.ts'), 'export class UserClient {}\n');

  indexRepos(db, mirrorRoot, 'acme');
}

const PROBES: Probes = {
  paths: ['src/client.ts'],
  basenames: ['client.ts'],
  symbols: ['getUsers', 'UserClient'],
  imports: ['@acme/shared'],
  routes: ['/api/v2/users'],
  tables: [],
};

describe('buildContextPack', () => {
  it('writes the numbered diff and ranked context files with headers, patterns first', () => {
    setup();

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'api',
      numberedDiff: '== numbered diff ==',
      probes: PROBES,
      workspaceRoot,
    });

    expect(existsSync(pack.dir)).toBe(true);
    expect(readFileSync(join(pack.dir, 'diff.txt'), 'utf8')).toBe('== numbered diff ==');
    expect(pack.contextFiles).toBe(4);
    expect(pack.skippedForBudget).toBe(0);

    // Pattern file (README.md) first, then ranked candidates (score desc, then file path).
    const files = [
      '01__web__README.md',
      '02__web__src_api.ts',
      '03__shared__src_user-client.ts',
      '04__web__src_other.ts',
    ];
    for (const name of files) {
      expect(existsSync(join(pack.dir, 'context', name))).toBe(true);
    }
    const readme = readFileSync(join(pack.dir, 'context', '01__web__README.md'), 'utf8');
    expect(readme).toContain('# repo: acme/web\n# file: README.md\n');
    expect(readme).toContain('# web');
    const api = readFileSync(join(pack.dir, 'context', '02__web__src_api.ts'), 'utf8');
    expect(api).toContain('export function getUsers()');
  });

  it('honours the budget and reports skipped files', () => {
    setup();

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'api',
      numberedDiff: '',
      probes: PROBES,
      budgetChars: 60,
      workspaceRoot,
    });

    expect(pack.contextFiles).toBe(1); // only the pattern file fits
    expect(pack.skippedForBudget).toBe(3);
  });

  it('fails with a clear message when nothing has been mirrored', () => {
    expect(() =>
      buildContextPack({
        db,
        mirrorRoot,
        owner: 'acme',
        prRepo: 'api',
        numberedDiff: '',
        probes: PROBES,
        workspaceRoot,
      }),
    ).toThrow(/run "peer mirror/);
  });
});
