import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Probes } from '../../src/context/probes.js';
import { findContextFiles } from '../../src/context/search.js';
import { indexRepos } from '../../src/mirror/indexer.js';
import { openDb, upsertRepo, type Db } from '../../src/store/db.js';

let root: string;
let mirrorRoot: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-search-'));
  mirrorRoot = join(root, 'mirror');
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

function indexFixture(): void {
  upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });
  upsertRepo(db, { owner: 'acme', name: 'web', defaultBranch: 'main' });
  upsertRepo(db, { owner: 'acme', name: 'shared', defaultBranch: 'main' });

  // acme/api is the PR repo — its matching file must never appear in results.
  writeFileSync(
    join(repoDir('api'), 'src', 'client.ts'),
    'export class UserClient {\n  getUsers() {\n    return http.get("/api/v2/users");\n  }\n}\n',
  );
  // web: symbol + route content match.
  writeFileSync(
    join(repoDir('web'), 'src', 'api.ts'),
    'export function getUsers() {\n  return http.get("/api/v2/users");\n}\n',
  );
  // web: content-only match.
  writeFileSync(join(repoDir('web'), 'src', 'other.ts'), '// TODO: replace /api/v2/users\n');
  // shared: symbol-only match.
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

describe('findContextFiles', () => {
  it('ranks symbol > content matches, excludes the PR repo, and sorts deterministically', () => {
    indexFixture();

    const results = findContextFiles(db, mirrorRoot, 'acme', 'api', PROBES, 10);

    expect(results.map((r) => `${r.repo}/${r.file}`)).toEqual([
      'acme/web/src/api.ts',
      'acme/shared/src/user-client.ts',
      'acme/web/src/other.ts',
    ]);
    expect(results.map((r) => r.score)).toEqual([5, 4, 1]);
    expect(results.map((r) => r.via)).toEqual([
      ['symbol', 'content'],
      ['symbol', 'content'],
      ['content'],
    ]);
    expect(results.some((r) => r.repo === 'acme/api')).toBe(false);
  });

  it('respects maxFiles', () => {
    indexFixture();

    const results = findContextFiles(db, mirrorRoot, 'acme', 'api', PROBES, 2);

    expect(results).toHaveLength(2);
  });

  it('returns an empty list when nothing matches', () => {
    indexFixture();

    const results = findContextFiles(db, mirrorRoot, 'acme', 'api', {
      paths: [],
      basenames: ['nope.ts'],
      symbols: ['DoesNotExist'],
      imports: [],
      routes: [],
      tables: [],
    }, 10);

    expect(results).toEqual([]);
  });
});
