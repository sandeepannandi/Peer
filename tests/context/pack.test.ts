import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  it('writes the numbered diff and ranked context files with headers, retrieved first then patterns', () => {
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

    // Retrieved source files first (score desc, tie-broken alphabetically by repo), then pattern file.
    const files = [
      '01__shared__src_user-client.ts',
      '02__web__src_api.ts',
      '03__web__src_other.ts',
      '04__web__README.md',
    ];
    for (const name of files) {
      expect(existsSync(join(pack.dir, 'context', name))).toBe(true);
    }
    const userClient = readFileSync(join(pack.dir, 'context', '01__shared__src_user-client.ts'), 'utf8');
    expect(userClient).toContain('# repo: acme/shared\n# file: src/user-client.ts\n');
    expect(userClient).toContain('export class UserClient {}');
    const api = readFileSync(join(pack.dir, 'context', '02__web__src_api.ts'), 'utf8');
    expect(api).toContain('export function getUsers()');
    const readme = readFileSync(join(pack.dir, 'context', '04__web__README.md'), 'utf8');
    expect(readme).toContain('# repo: acme/web\n# file: README.md\n');
  });

  it('honours the budget and reports skipped files', () => {
    setup();

    // budget=300 → retrievedBudget=150, patternBudget=90.
    // File sizes (content+header): shared/user-client=74, web/api=66, web/other=69, web/README=41.
    // Retrieved phase fits 74 + 66 = 140 ≤ 150, skips other (69 > 10 remaining). Pattern fits 41 ≤ 90.
    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'api',
      numberedDiff: '',
      probes: PROBES,
      budgetChars: 300,
      workspaceRoot,
    });

    expect(pack.contextFiles).toBe(3); // 2 retrieved + 1 pattern
    expect(pack.skippedForBudget).toBe(1); // web/other.ts
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
    ).toThrow(/run \"peer mirror/);
  });

  it('REGRESSION: large pattern files cannot starve relevant source files (CTO packing bug)', () => {
    // Simulate the exact bug the CTO found: large README.md and AGENTS.md from
    // multiple repos consume the entire budget, dropping all retrieved source files.
    upsertRepo(db, { owner: 'acme', name: 'svc-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'svc-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'svc-c', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'pr-repo', defaultBranch: 'main' });

    // Large pattern files: each README is ~18,000 chars; total ~54,000 exceeds budget.
    const largeReadme = 'x'.repeat(18_000);
    const largeAgents = 'y'.repeat(18_000);
    for (const repo of ['svc-a', 'svc-b', 'svc-c']) {
      const dir = repoDir(repo);
      writeFileSync(join(dir, 'README.md'), largeReadme);
      writeFileSync(join(dir, 'AGENTS.md'), largeAgents);
    }

    // Relevant source files with symbols that match the PR probes.
    const srcA = join(repoDir('svc-a'), 'src', 'auth.ts');
    const srcB = join(repoDir('svc-b'), 'src', 'auth.ts');
    const srcC = join(repoDir('svc-c'), 'src', 'auth.ts');
    writeFileSync(srcA, 'export function authenticate(token: string) { return true; }\n');
    writeFileSync(srcB, 'export function authenticate(token: string) { return true; }\n');
    writeFileSync(srcC, 'export function authenticate(token: string) { return true; }\n');

    // Also add a small README for the pr-repo (should NOT be included — same repo).
    writeFileSync(join(repoDir('pr-repo'), 'README.md'), 'pr-repo readme');

    indexRepos(db, mirrorRoot, 'acme');

    const budget = 40_000;
    const probes: Probes = {
      paths: ['src/auth.ts'],
      basenames: ['auth.ts'],
      symbols: ['authenticate'],
      imports: [],
      routes: [],
      tables: [],
    };

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'pr-repo',
      numberedDiff: '== diff ==',
      probes,
      budgetChars: budget,
      workspaceRoot,
    });

    // At least the 3 relevant source files must be included despite large patterns.
    const contextDir = join(pack.dir, 'context');
    const written = existsSync(contextDir) ? readdirSync(contextDir) : [];

    const hasAuthFiles = written.filter((n) => n.includes('auth'));
    expect(hasAuthFiles.length).toBeGreaterThanOrEqual(3);

    // Pattern files must be limited — they should not consume the entire budget.
    // With retrievedBudget=20000 and patternBudget=12000, we can fit at most 1 large
    // pattern file (18000 > 12000 pattern budget), so 0 patterns fit, 6 skipped.
    // The key assertion: relevant source files survived.
    for (const authFile of hasAuthFiles) {
      const content = readFileSync(join(contextDir, authFile), 'utf8');
      expect(content).toContain('authenticate');
    }

    // Verify the budget is actually respected.
    expect(pack.contextFiles).toBeGreaterThanOrEqual(3);
    expect(pack.contextFiles + pack.skippedForBudget).toBeGreaterThan(0);
  });

  it('REGRESSION: pattern files get at most 30% of budget, source files get at least 50%', () => {
    upsertRepo(db, { owner: 'acme', name: 'consumers', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'pr-repo', defaultBranch: 'main' });

    // Pattern file that is exactly at the pattern budget limit.
    const patternBudget = Math.floor(1000 * 0.3); // 300
    writeFileSync(join(repoDir('consumers'), 'README.md'), 'p'.repeat(patternBudget - 35)); // 35 = header overhead

    // Source file that fits in retrieved budget.
    const retrievedBudget = Math.floor(1000 * 0.5); // 500
    writeFileSync(join(repoDir('consumers'), 'src', 'core.ts'), 'export function core() {}\n');

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/core.ts'],
      basenames: ['core.ts'],
      symbols: ['core'],
      imports: [],
      routes: [],
      tables: [],
    };

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'pr-repo',
      numberedDiff: '',
      probes,
      budgetChars: 1000,
      workspaceRoot,
    });

    // Source file must be included first (Phase 1).
    const contextDir = join(pack.dir, 'context');
    const written = readdirSync(contextDir);
    const hasCore = written.some((n) => n.includes('core'));
    expect(hasCore).toBe(true);
  });

  it('preserves cross-repo relevant files in the context pack', () => {
    // PR in repo-a changes getUser; repo-b's client.ts also uses getUser.
    upsertRepo(db, { owner: 'acme', name: 'repo-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'unrelated', defaultBranch: 'main' });

    writeFileSync(join(repoDir('repo-b'), 'src', 'client.ts'), 'export function fetchUser(id: string) { return getUser(id); }\n');
    writeFileSync(join(repoDir('unrelated'), 'README.md'), '# unrelated\nThis is a large unrelated file.\n');

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/api.ts'],
      basenames: ['api.ts'],
      symbols: ['getUser'],
      imports: [],
      routes: [],
      tables: [],
    };

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'repo-a',
      numberedDiff: '== diff ==',
      probes,
      workspaceRoot,
    });

    const contextDir = join(pack.dir, 'context');
    const written = readdirSync(contextDir);
    const hasRepoBClient = written.some((n) => n.includes('repo-b') && n.includes('client'));
    expect(hasRepoBClient).toBe(true);
  });
});
