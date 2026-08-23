import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractProbes } from '../../src/context/probes.js';
import { buildContextPack } from '../../src/context/pack.js';
import { findContextFiles } from '../../src/context/search.js';
import { runLocalReviewer } from '../../src/local/reviewer.js';
import { indexRepos } from '../../src/mirror/indexer.js';
import { openDb, upsertRepo, type Db } from '../../src/store/db.js';
import { buildNumberedDiff, parseUnifiedDiff } from '../../src/util/diff.js';

let root: string;
let mirrorRoot: string;
let workspaceRoot: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-crossrepo-'));
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

function contextFileNames(dir: string): string[] {
  const contextDir = join(dir, 'context');
  return existsSync(contextDir) ? readdirSync(contextDir) : [];
}

describe('cross-repo integration: retrieval → packing → reviewer', () => {
  it('PR in repo-a depends on repo-b; context pack retains repo-b files that the reviewer cites', () => {
    // ── Setup: 3 repos ──
    upsertRepo(db, { owner: 'acme', name: 'repo-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'unrelated', defaultBranch: 'main' });

    // repo-a: PR changes getUser signature
    writeFileSync(join(repoDir('repo-a'), 'src', 'api.ts'),
      'export function getUser(id: string): string { return `user:${id}`; }\n');

    // repo-b: consumer of getUser — this is the cross-repo dependency
    writeFileSync(join(repoDir('repo-b'), 'src', 'client.ts'),
      'export function fetchProfile(id: string): string { return getUser(id); }\n');

    // unrelated: has a large README but no symbol overlap
    writeFileSync(join(repoDir('unrelated'), 'README.md'),
      '# Unrelated\n' + 'z'.repeat(5_000) + '\n');

    indexRepos(db, mirrorRoot, 'acme');

    // ── Step 1: Simulate the PR diff and extract probes ──
    const diff = [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,2 +1,2 @@',
      '-export function getUser(id: number): string {',
      '+export function getUser(id: string): string {',
      '   return `user:${id}`;',
      ' }',
    ].join('\n');

    const fileDiffs = parseUnifiedDiff(diff);
    const probes = extractProbes(fileDiffs);

    // Probes should capture the getUser symbol.
    expect(probes.symbols).toContain('getUser');

    // ── Step 2: Retrieval identifies repo-b files ──
    const candidates = findContextFiles(db, mirrorRoot, 'acme', 'repo-a', probes, 12);
    const repoBCandidates = candidates.filter((c) => c.repo === 'acme/repo-b');
    expect(repoBCandidates.length).toBeGreaterThan(0);
    expect(repoBCandidates.some((c) => c.file.includes('client'))).toBe(true);

    // ── Step 3: Packing retains the cross-repo files ──
    const pack = buildContextPack({
      db, mirrorRoot, owner: 'acme', prRepo: 'repo-a',
      numberedDiff: buildNumberedDiff(fileDiffs),
      probes, budgetChars: 40_000, workspaceRoot,
    });

    const files = contextFileNames(pack.dir);
    const hasRepoBClient = files.some((f) => f.includes('repo-b') && f.includes('client'));
    expect(hasRepoBClient).toBe(true);

    // Verify the actual file content contains cross-repo evidence.
    const repoBFile = files.find((f) => f.includes('repo-b') && f.includes('client'));
    const content = readFileSync(join(pack.dir, 'context', repoBFile!), 'utf8');
    expect(content).toContain('# repo: acme/repo-b');
    expect(content).toContain('getUser');

    // ── Step 4: Reviewer can cite the cross-repo evidence ──
    const review = runLocalReviewer(pack.dir, fileDiffs, 'acme/repo-a#1');

    expect(review.overall).toBe('changes_requested');
    expect(review.findings.length).toBeGreaterThan(0);

    // The finding must cite repo-b as evidence.
    const evidence = review.findings[0]!.evidence;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((e) => e.repo === 'acme/repo-b')).toBe(true);
    expect(evidence.some((e) => e.file.includes('client'))).toBe(true);
  });

  it('cross-repo files survive packing even when pattern files from unrelated repos are large', () => {
    upsertRepo(db, { owner: 'acme', name: 'repo-a', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-b', defaultBranch: 'main' });
    upsertRepo(db, { owner: 'acme', name: 'repo-c', defaultBranch: 'main' });

    // repo-b has relevant source code.
    writeFileSync(join(repoDir('repo-b'), 'src', 'handler.ts'),
      'export function handleEvent(evt: string) { processEvent(evt); }\n');

    // repo-c has only large pattern files (no relevant code).
    writeFileSync(join(repoDir('repo-c'), 'README.md'), 'x'.repeat(20_000));
    writeFileSync(join(repoDir('repo-c'), 'AGENTS.md'), 'y'.repeat(20_000));

    indexRepos(db, mirrorRoot, 'acme');

    const diff = [
      'diff --git a/src/handler.ts b/src/handler.ts',
      '--- a/src/handler.ts',
      '+++ b/src/handler.ts',
      '@@ -1,2 +1,2 @@',
      '-export function handleEvent(evt: string) {',
      '+export function handleEvent(evt: string): void {',
      '   processEvent(evt);',
      ' }',
    ].join('\n');

    const fileDiffs = parseUnifiedDiff(diff);
    const probes = extractProbes(fileDiffs);

    const pack = buildContextPack({
      db, mirrorRoot, owner: 'acme', prRepo: 'repo-a',
      numberedDiff: buildNumberedDiff(fileDiffs),
      probes, budgetChars: 40_000, workspaceRoot,
    });

    const files = contextFileNames(pack.dir);
    const hasRepoBHandler = files.some((f) => f.includes('repo-b') && f.includes('handler'));
    expect(hasRepoBHandler).toBe(true);

    // repo-c pattern files should be limited (budget cap).
    const repoCFiles = files.filter((f) => f.includes('repo-c'));
    expect(repoCFiles.length).toBeLessThanOrEqual(1);

    // The relevant cross-repo file survived.
    const review = runLocalReviewer(pack.dir, fileDiffs, 'acme/repo-a#1');
    expect(review.findings.length).toBeGreaterThan(0);
    expect(review.findings[0]!.evidence.some((e) => e.repo === 'acme/repo-b')).toBe(true);
  });
});
