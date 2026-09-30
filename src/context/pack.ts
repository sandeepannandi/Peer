import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listReposByOwner, type Db } from '../store/db.js';
import { hashText, pinCommit, readSnapshot, type SnapshotManifest } from './manifest.js';
import type { Probes } from './probes.js';
import { findContextFiles, type ContextCandidate } from './search.js';

export interface PackOptions {
  db: Db;
  mirrorRoot: string;
  owner: string;
  prRepo: string;
  numberedDiff: string;
  probes: Probes;
  maxFiles?: number;
  budgetChars?: number;
  workspaceRoot?: string;
  prHead?: string;
  coverageLimits?: string[];
}

export interface PackResult {
  jobId: string;
  dir: string;
  contextFiles: number;
  skippedForBudget: number;
  manifest: SnapshotManifest;
}

const PATTERN_FILES = ['AGENTS.md', 'README.md'];

/** Pattern files may consume at most this fraction of the total budget. */
const PATTERN_BUDGET_FRACTION = 0.3;

/** Minimum fraction reserved for retrieved / source files. */
const RETRIEVED_BUDGET_FRACTION = 0.5;

export function buildContextPack(options: PackOptions): PackResult {
  const {
    db,
    mirrorRoot,
    owner,
    prRepo,
    numberedDiff,
    probes,
    maxFiles = 12,
    budgetChars = 40000,
    workspaceRoot = './data/workspace',
  } = options;

  const repos = listReposByOwner(db, owner);
  if (repos.length === 0) {
    throw new Error(`No repos recorded for "${owner}" — run "peer mirror --owner ${owner}" first.`);
  }

  const commits = new Map(
    repos.map((repo) => [
      `${repo.owner}/${repo.name}`,
      pinCommit(join(mirrorRoot, repo.owner, repo.name)),
    ]),
  );
  const manifest: SnapshotManifest = {
    version: 1,
    prHead: options.prHead ?? null,
    diffSha256: hashText(numberedDiff),
    files: [],
    coverage: {
      complete: false,
      limitations: [
        'Heuristic retrieval is not an exhaustive consumer search',
        ...(options.coverageLimits ?? []),
        ...(!options.prHead ? ['PR head is not pinned (local fixture or context-only run)'] : []),
        ...repos
          .filter((repo) => !commits.get(`${repo.owner}/${repo.name}`))
          .map((repo) => `Unpinned mirror: ${repo.owner}/${repo.name}`),
      ],
    },
  };

  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(workspaceRoot, jobId);
  const contextDir = join(dir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(dir, 'diff.txt'), numberedDiff);

  const candidates = findContextFiles(db, mirrorRoot, owner, prRepo, probes, maxFiles);

  // Budget allocation: retrieved files get at least RETRIEVED_BUDGET_FRACTION;
  // pattern files are capped at PATTERN_BUDGET_FRACTION.
  const retrievedBudget = Math.floor(budgetChars * RETRIEVED_BUDGET_FRACTION);
  const patternBudget = Math.floor(budgetChars * PATTERN_BUDGET_FRACTION);
  // Remaining budget is freely available to whichever files come later.

  let contextFiles = 0;
  let skippedForBudget = 0;
  let index = 0;

  // ── Phase 1: pack retrieved / source candidates into the retrieved budget ──
  const seen = new Set<string>();
  let retrievedRemaining = retrievedBudget;

  for (const candidate of candidates) {
    const key = `${candidate.repo}/${candidate.file}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const repoName = candidate.repo.slice(candidate.repo.indexOf('/') + 1);
    const abs = join(mirrorRoot, owner, repoName, candidate.file);

    let content: string | null;
    try {
      if (!commits.get(candidate.repo) && statSync(abs).size > retrievedRemaining) {
        skippedForBudget += 1;
        continue;
      }
      content = readSnapshot(
        join(mirrorRoot, owner, repoName),
        candidate.file,
        commits.get(candidate.repo) ?? null,
      );
    } catch {
      skippedForBudget += 1;
      continue;
    }

    if (content === null || content.includes('\0')) {
      skippedForBudget += 1;
      continue;
    }
    const header = `# repo: ${candidate.repo}\n# file: ${candidate.file}\n`;
    const totalLen = header.length + content.length;
    if (retrievedRemaining - totalLen < 0) {
      skippedForBudget += 1;
      continue;
    }
    retrievedRemaining -= totalLen;
    index += 1;
    const name = contextFileName(index, candidate.repo, candidate.file, contextDir);
    writeFileSync(join(contextDir, name), header + content);
    manifest.files.push({
      repo: candidate.repo,
      file: candidate.file,
      packedPath: `context/${name}`,
      commit: commits.get(candidate.repo) ?? null,
      sha256: hashText(content),
      content,
    });
    contextFiles += 1;
  }

  // ── Phase 2: add pattern files (README / AGENTS) within their budget cap ──
  const patternFiles: ContextCandidate[] = [];
  for (const repo of repos) {
    if (repo.name === prRepo) continue;
    for (const name of PATTERN_FILES) {
      const key = `${repo.owner}/${repo.name}/${name}`;
      if (seen.has(key)) continue;
      if (existsSync(join(mirrorRoot, repo.owner, repo.name, name))) {
        patternFiles.push({
          repo: `${repo.owner}/${repo.name}`,
          file: name,
          score: 0, // patterns are supplementary, not ranked above source files
          via: ['pattern'],
        });
      }
    }
  }

  let patternRemaining = patternBudget;
  for (const candidate of patternFiles) {
    const repoName = candidate.repo.slice(candidate.repo.indexOf('/') + 1);
    const abs = join(mirrorRoot, owner, repoName, candidate.file);

    let content: string | null;
    try {
      if (!commits.get(candidate.repo) && statSync(abs).size > patternRemaining) {
        skippedForBudget += 1;
        continue;
      }
      content = readSnapshot(
        join(mirrorRoot, owner, repoName),
        candidate.file,
        commits.get(candidate.repo) ?? null,
      );
    } catch {
      skippedForBudget += 1;
      continue;
    }

    if (content === null || content.includes('\0')) {
      skippedForBudget += 1;
      continue;
    }
    const header = `# repo: ${candidate.repo}\n# file: ${candidate.file}\n`;
    const totalLen = header.length + content.length;
    if (patternRemaining - totalLen < 0) {
      skippedForBudget += 1;
      continue;
    }
    patternRemaining -= totalLen;
    index += 1;
    const name = contextFileName(index, candidate.repo, candidate.file, contextDir);
    writeFileSync(join(contextDir, name), header + content);
    manifest.files.push({
      repo: candidate.repo,
      file: candidate.file,
      packedPath: `context/${name}`,
      commit: commits.get(candidate.repo) ?? null,
      sha256: hashText(content),
      content,
    });
    contextFiles += 1;
  }

  if (skippedForBudget)
    manifest.coverage.limitations.push(
      `${skippedForBudget} inputs skipped for budget or unavailable content`,
    );
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { jobId, dir, contextFiles, skippedForBudget, manifest };
}

function contextFileName(index: number, repo: string, file: string, contextDir: string): string {
  const repoName = repo.slice(repo.indexOf('/') + 1);
  const base = `${String(index).padStart(2, '0')}__${repoName}__${file.replace(/[^\w.-]+/g, '_')}`;
  let name = base;
  let suffix = 2;
  while (existsSync(join(contextDir, name))) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  return name;
}
