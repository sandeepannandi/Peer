import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'peer-realism-'));
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

function contextFiles(dir: string): string[] {
  const contextDir = join(dir, 'context');
  return existsSync(contextDir) ? readdirSync(contextDir) : [];
}

/** Generate a source file with a specific symbol declaration. */
function genSource(dir: string, relPath: string, symbol: string, bodyLen: number = 50): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `export function ${symbol}() { ${'a'.repeat(bodyLen)} }\n`);
}

describe('production-realism: context packing under realistic conditions', () => {
  it('large README + AGENTS from multiple repos cannot starve 10 relevant source files', () => {
    const repos = [
      'svc-auth',
      'svc-pay',
      'svc-user',
      'svc-notif',
      'svc-gateway',
      'svc-config',
      'svc-logging',
      'svc-metrics',
      'svc-cache',
      'svc-queue',
    ];
    const prRepo = 'svc-api';

    upsertRepo(db, { owner: 'acme', name: prRepo, defaultBranch: 'main' });
    for (const repo of repos) {
      upsertRepo(db, { owner: 'acme', name: repo, defaultBranch: 'main' });
      writeFileSync(join(repoDir(repo), 'README.md'), 'x'.repeat(5_000));
      writeFileSync(join(repoDir(repo), 'AGENTS.md'), 'x'.repeat(5_000));
    }

    // Each repo has a unique symbol that matches PR probes.
    for (let i = 0; i < repos.length; i++) {
      genSource(repoDir(repos[i]!), 'src/core.ts', `core_${i}`);
    }

    indexRepos(db, mirrorRoot, 'acme');

    const symbols = repos.map((_, i) => `core_${i}`);
    const probes: Probes = {
      paths: ['src/api.ts'],
      basenames: ['api.ts'],
      symbols,
      imports: [],
      routes: [],
      tables: [],
    };

    const budget = 40_000;
    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo,
      numberedDiff: '== diff ==',
      probes,
      budgetChars: budget,
      workspaceRoot,
    });

    const files = contextFiles(pack.dir);
    const sourceFiles = files.filter((f) => f.includes('src_core'));
    const patternFiles = files.filter((f) => f.endsWith('.md'));

    // All 10 source files must survive — the CTO's original bug dropped them all.
    expect(sourceFiles.length).toBe(10);

    // Pattern files are limited by their 30% budget cap (12000 chars).
    // Each pattern = 5000 content + ~35 header = 5035. Cap allows 2 patterns (10070 ≤ 12000).
    expect(patternFiles.length).toBeLessThanOrEqual(3);

    // Budget is respected.
    expect(pack.contextFiles).toBe(sourceFiles.length + patternFiles.length);
  });

  it('tight budget: retrieved files are prioritised over pattern files', () => {
    upsertRepo(db, { owner: 'acme', name: 'svc-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'svc-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'pr-repo', defaultBranch: 'main' });

    // Large pattern file that would consume all budget under old logic.
    writeFileSync(join(repoDir('svc-a'), 'README.md'), 'x'.repeat(30_000));
    writeFileSync(join(repoDir('svc-b'), 'README.md'), 'x'.repeat(30_000));

    // Small but highly relevant source file.
    genSource(repoDir('svc-a'), 'src/handler.ts', 'handleRequest', 100);
    genSource(repoDir('svc-b'), 'src/handler.ts', 'handleRequest', 100);

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/api.ts'],
      basenames: ['api.ts'],
      symbols: ['handleRequest'],
      imports: [],
      routes: [],
      tables: [],
    };

    // Budget = 1000. retrievedBudget = 500, patternBudget = 300.
    // Source files: header(46) + content(~106) ≈ 152 each. Two fit in 500.
    // Pattern files: 30000+ each, neither fits in 300.
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

    const files = contextFiles(pack.dir);
    const sourceFiles = files.filter((f) => f.includes('handler'));
    const patternFiles = files.filter((f) => f.includes('README'));

    // Source files must be included even though patterns are 30KB each.
    expect(sourceFiles.length).toBe(2);
    expect(patternFiles.length).toBe(0); // too large for pattern budget
  });

  it('competes files with different relevance scores and keeps highest-ranked', () => {
    upsertRepo(db, { owner: 'acme', name: 'high-score', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'mid-score', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'low-score', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'pr-repo', defaultBranch: 'main' });

    // high-score: symbol + content + basename match
    writeFileSync(
      join(repoDir('high-score'), 'src', 'api.ts'),
      'export function processPayment() { return fetch("/api/payments"); }\n',
    );
    // mid-score: symbol match only
    writeFileSync(
      join(repoDir('mid-score'), 'src', 'api.ts'),
      'export function processPayment() { return "mid"; }\n',
    );
    // low-score: content match only
    writeFileSync(
      join(repoDir('low-score'), 'src', 'utils.ts'),
      '// handles /api/payments routing\n',
    );

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/api.ts'],
      basenames: ['api.ts'],
      symbols: ['processPayment'],
      imports: [],
      routes: ['/api/payments'],
      tables: [],
    };

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'pr-repo',
      numberedDiff: '',
      probes,
      budgetChars: 5000,
      workspaceRoot,
    });

    const files = contextFiles(pack.dir);
    // All 3 should fit, but high-score must come before mid-score and low-score.
    const highIdx = files.findIndex((f) => f.includes('high-score'));
    const midIdx = files.findIndex((f) => f.includes('mid-score'));
    const lowIdx = files.findIndex((f) => f.includes('low-score'));
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('handles a single large source file that exceeds the entire budget gracefully', () => {
    upsertRepo(db, { owner: 'acme', name: 'big-repo', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'pr-repo', defaultBranch: 'main' });

    // File too large to fit even in retrieved budget.
    const bigContent = 'export function x() { ' + 'a'.repeat(30_000) + ' }\n';
    writeFileSync(join(repoDir('big-repo'), 'src', 'huge.ts'), bigContent);

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/huge.ts'],
      basenames: ['huge.ts'],
      symbols: ['x'],
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
      budgetChars: 40_000,
      workspaceRoot,
    });

    // File is ~30038 bytes > retrievedBudget (20000), so skipped.
    const files = contextFiles(pack.dir);
    expect(files.length).toBe(0);
    expect(pack.skippedForBudget).toBe(1);
  });

  it('cross-repository files from multiple repos survive packing', () => {
    upsertRepo(db, { owner: 'acme', name: 'repo-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-c', defaultBranch: 'main' });

    writeFileSync(
      join(repoDir('repo-b'), 'src', 'auth.ts'),
      'export function validateToken() {}\n',
    );
    writeFileSync(
      join(repoDir('repo-c'), 'src', 'auth.ts'),
      'export function validateToken() {}\n',
    );

    indexRepos(db, mirrorRoot, 'acme');

    const probes: Probes = {
      paths: ['src/auth.ts'],
      basenames: ['auth.ts'],
      symbols: ['validateToken'],
      imports: [],
      routes: [],
      tables: [],
    };

    const pack = buildContextPack({
      db,
      mirrorRoot,
      owner: 'acme',
      prRepo: 'repo-a',
      numberedDiff: '',
      probes,
      budgetChars: 40_000,
      workspaceRoot,
    });

    const files = contextFiles(pack.dir);
    const hasRepoB = files.some((f) => f.includes('repo-b'));
    const hasRepoC = files.some((f) => f.includes('repo-c'));
    expect(hasRepoB).toBe(true);
    expect(hasRepoC).toBe(true);
  });
});
