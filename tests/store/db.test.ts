import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRepoFiles,
  getRepoId,
  insertFile,
  insertSymbol,
  listReposByOwner,
  markRepoIndexed,
  openDb,
  upsertRepo,
  type Db,
} from '../../src/store/db.js';

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-db-'));
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function count(db: Db, table: 'files' | 'symbols'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('store/db', () => {
  it('upserts a repo idempotently and lists by owner', () => {
    const id = upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });

    expect(getRepoId(db, 'acme', 'api')).toBe(id);
    expect(upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' })).toBe(id);

    const repos = listReposByOwner(db, 'acme');
    expect(repos).toHaveLength(1);
    expect(repos[0]?.default_branch).toBe('main');
    expect(listReposByOwner(db, 'other')).toEqual([]);
  });

  it('records files and symbols, then clears them per repo', () => {
    const repoId = upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });
    const fileId = insertFile(db, repoId, {
      path: 'src/a.ts',
      basename: 'a.ts',
      lang: 'ts',
      size: 12,
    });
    insertSymbol(db, fileId, { kind: 'function', name: 'alpha', line: 1 });

    expect(count(db, 'files')).toBe(1);
    expect(count(db, 'symbols')).toBe(1);

    clearRepoFiles(db, repoId);
    expect(count(db, 'files')).toBe(0);
    expect(count(db, 'symbols')).toBe(0);
  });

  it('marks a repo as indexed', () => {
    const repoId = upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });
    markRepoIndexed(db, repoId);

    const repo = listReposByOwner(db, 'acme')[0];
    expect(repo?.last_indexed_at).toBeTruthy();
  });
});
