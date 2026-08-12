import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractSymbols, indexRepos } from '../../src/mirror/indexer.js';
import { listReposByOwner, openDb, upsertRepo, type Db } from '../../src/store/db.js';

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-index-'));
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('extractSymbols', () => {
  it('extracts functions, classes, interfaces and consts from TypeScript', () => {
    const content = [
      'export function sum(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export class User {',
      '  name = "";',
      '}',
      'interface Payload {',
      '  id: string;',
      '}',
      'export const MAX_ITEMS = 10;',
    ].join('\n');

    expect(extractSymbols('ts', content)).toEqual([
      { kind: 'function', name: 'sum', line: 1 },
      { kind: 'class', name: 'User', line: 4 },
      { kind: 'interface', name: 'Payload', line: 7 },
      { kind: 'const', name: 'MAX_ITEMS', line: 10 },
    ]);
  });

  it('extracts Python and Go symbols', () => {
    expect(extractSymbols('py', 'async def fetch_user(user_id):\n    pass\nclass Store:\n    pass')).toEqual([
      { kind: 'function', name: 'fetch_user', line: 1 },
      { kind: 'class', name: 'Store', line: 3 },
    ]);

    expect(
      extractSymbols(
        'go',
        'func (h *Handler) Serve() error {\n\treturn nil\n}\ntype User struct {\n\tID int\n}',
      ),
    ).toEqual([
      { kind: 'function', name: 'Serve', line: 1 },
      { kind: 'type', name: 'User', line: 4 },
    ]);
  });

  it('returns nothing for unknown languages or non-declaration lines', () => {
    expect(extractSymbols('md', 'def fake()')).toEqual([]);
    expect(extractSymbols('ts', '  const nested = 1; // indented')).toEqual([]);
    expect(extractSymbols('ts', 'foo();')).toEqual([]);
  });
});

describe('indexRepos', () => {
  it('builds the file/symbol index from the mirror and marks the repo indexed', () => {
    const mirrorRoot = join(root, 'mirror');
    const repoDir = join(mirrorRoot, 'acme', 'api');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'sum.ts'), 'export function sum(a: number) { return a; }\n');
    writeFileSync(join(repoDir, 'README.md'), '# docs\n');
    upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });

    const outcome = indexRepos(db, mirrorRoot, 'acme');

    expect(outcome).toEqual({ repos: [{ repo: 'acme/api', files: 2, symbols: 1 }], skipped: [] });
    expect(listReposByOwner(db, 'acme')[0]?.last_indexed_at).toBeTruthy();
  });

  it('re-indexes cleanly — old symbols do not accumulate', () => {
    const mirrorRoot = join(root, 'mirror');
    const repoDir = join(mirrorRoot, 'acme', 'api');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'a.ts'), 'export function alpha() {}\n');
    upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });

    indexRepos(db, mirrorRoot, 'acme');
    writeFileSync(join(repoDir, 'a.ts'), 'export function beta() {}\n');
    const second = indexRepos(db, mirrorRoot, 'acme');

    expect(second).toEqual({ repos: [{ repo: 'acme/api', files: 1, symbols: 1 }], skipped: [] });
    const symbol = db.prepare('SELECT name FROM symbols').get() as { name: string };
    expect(symbol.name).toBe('beta');
  });

  it('fails with a clear message when no repos are recorded', () => {
    expect(() => indexRepos(db, join(root, 'mirror'), 'acme')).toThrow(/run "peer mirror/);
  });

  it('skips repos whose mirror directory is missing instead of aborting', () => {
    const repoDir = join(root, 'mirror', 'acme', 'api');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'a.ts'), 'export function alpha() {}\n');
    upsertRepo(db, { owner: 'acme', name: 'api', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'missing', defaultBranch: 'main' });

    const outcome = indexRepos(db, join(root, 'mirror'), 'acme');

    expect(outcome.skipped).toEqual(['acme/missing (mirror directory missing)']);
    expect(outcome.repos).toEqual([{ repo: 'acme/api', files: 1, symbols: 1 }]);
  });
});
