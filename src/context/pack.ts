import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  /** Character limit for numbered diff + packed source bytes (not tokenizer tokens). */
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
  if (
    !Number.isSafeInteger(budgetChars) ||
    budgetChars < 1 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1
  ) {
    throw new Error('Context budget and file limit must be positive integers.');
  }
  if (numberedDiff.length > budgetChars)
    throw new Error(
      'Numbered diff exceeds context character budget; review aborted without truncating the diff.',
    );
  const repos = listReposByOwner(db, owner);
  if (!repos.length)
    throw new Error(`No repos recorded for "${owner}" — run "peer mirror --owner ${owner}" first.`);
  const commits = new Map(
    repos.map((r) => [`${r.owner}/${r.name}`, pinCommit(join(mirrorRoot, r.owner, r.name))]),
  );
  const diagnostics: string[] = [];
  // Retrieve more than the pack file cap so a too-large top result cannot hide
  // smaller ranked sources that still fit. Keep the scan/result pool bounded.
  const candidates = findContextFiles(
    db,
    mirrorRoot,
    owner,
    prRepo,
    probes,
    Math.max(maxFiles * 4, 50),
    diagnostics,
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
        ...diagnostics,
        ...(!options.prHead ? ['PR head is not pinned (local fixture or context-only run)'] : []),
        ...repos
          .filter((r) => !commits.get(`${r.owner}/${r.name}`))
          .map((r) => `Unpinned mirror: ${r.owner}/${r.name}`),
      ],
    },
  };
  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(workspaceRoot, jobId);
  const contextDir = join(dir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(dir, 'diff.txt'), numberedDiff);
  const remainingBudget = budgetChars - numberedDiff.length;
  let remaining = remainingBudget;
  let patternRemaining = Math.floor(remainingBudget * 0.3);
  let skippedForBudget = 0;
  let sources = 0;
  const seen = new Set<string>();
  const attempted = new Set<string>();

  function pack(candidate: ContextCandidate, pattern: boolean): void {
    const key = `${candidate.repo}/${candidate.file}`;
    if (seen.has(key) || attempted.has(key)) return;
    attempted.add(key);
    if (!pattern && sources >= maxFiles) {
      manifest.coverage.limitations.push(`Packed source file limit: ${key}`);
      return;
    }
    const repoName = candidate.repo.slice(candidate.repo.indexOf('/') + 1);
    let content: string;
    try {
      content = readSnapshot(
        join(mirrorRoot, owner, repoName),
        candidate.file,
        commits.get(candidate.repo) ?? null,
      );
      if (content.includes('\0')) throw new Error('Binary input');
    } catch {
      manifest.coverage.limitations.push(`Unavailable snapshot input: ${key}`);
      return;
    }
    const header = `# repo: ${candidate.repo}\n# file: ${candidate.file}\n`;
    const total = header.length + content.length;
    if (total > remaining || (pattern && total > patternRemaining)) {
      skippedForBudget++;
      return;
    }
    remaining -= total;
    if (pattern) patternRemaining -= total;
    else sources++;
    const name = contextFileName(
      manifest.files.length + 1,
      candidate.repo,
      candidate.file,
      contextDir,
    );
    writeFileSync(join(contextDir, name), header + content);
    manifest.files.push({
      repo: candidate.repo,
      file: candidate.file,
      packedPath: `context/${name}`,
      commit: commits.get(candidate.repo) ?? null,
      sha256: hashText(content),
      content,
    });
    seen.add(key);
  }

  // Sources get first use of the entire remaining budget. Pattern files are
  // supplementary and capped at 30%, never reserving unused space from sources.
  for (const c of candidates.filter((c) => !PATTERN_FILES.includes(c.file))) pack(c, false);
  for (const repo of repos) {
    if (repo.name === prRepo) continue;
    for (const file of PATTERN_FILES) {
      try {
        readSnapshot(
          join(mirrorRoot, repo.owner, repo.name),
          file,
          commits.get(`${repo.owner}/${repo.name}`) ?? null,
        );
      } catch {
        continue;
      }
      pack({ repo: `${repo.owner}/${repo.name}`, file, score: 0, via: ['pattern'] }, true);
    }
  }
  if (skippedForBudget)
    manifest.coverage.limitations.push(`${skippedForBudget} inputs omitted by character budget`);
  const limitations = [...new Set(manifest.coverage.limitations)];
  manifest.coverage.limitations = limitations.slice(0, 100);
  if (limitations.length > 100)
    manifest.coverage.limitations.push(
      `${limitations.length - 100} additional coverage diagnostics omitted`,
    );
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        ...manifest,
        files: manifest.files.map(({ content, ...metadata }) => ({
          ...metadata,
          lines: content.split('\n').length,
        })),
      },
      null,
      2,
    ),
  );
  return { jobId, dir, contextFiles: manifest.files.length, skippedForBudget, manifest };
}

function contextFileName(index: number, repo: string, file: string, contextDir: string): string {
  const repoName = repo.slice(repo.indexOf('/') + 1);
  const base = `${String(index).padStart(2, '0')}__${repoName}__${file.replace(/[^\w.-]+/g, '_')}`;
  let name = base;
  let suffix = 2;
  while (existsSync(join(contextDir, name))) {
    name = `${base}-${suffix}`;
    suffix++;
  }
  return name;
}
