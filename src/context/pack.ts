import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileUtf8 } from '../mirror/indexer.js';
import { listReposByOwner, type Db } from '../store/db.js';
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
}

export interface PackResult {
  jobId: string;
  dir: string;
  contextFiles: number;
  skippedForBudget: number;
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
  const contextDir_ = contextDir; // alias for nested use

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
      if (statSync(abs).size > retrievedRemaining) {
        skippedForBudget += 1;
        continue;
      }
      content = readFileUtf8(abs);
    } catch {
      skippedForBudget += 1;
      continue;
    }

    const header = `# repo: ${candidate.repo}\n# file: ${candidate.file}\n`;
    const body = content ?? '';
    const totalLen = header.length + body.length;
    if (retrievedRemaining - totalLen < 0) {
      skippedForBudget += 1;
      continue;
    }
    retrievedRemaining -= totalLen;
    index += 1;
    const name = contextFileName(index, candidate.repo, candidate.file, contextDir_);
    writeFileSync(join(contextDir_, name), header + body);
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
      if (statSync(abs).size > patternRemaining) {
        skippedForBudget += 1;
        continue;
      }
      content = readFileUtf8(abs);
    } catch {
      skippedForBudget += 1;
      continue;
    }

    const header = `# repo: ${candidate.repo}\n# file: ${candidate.file}\n`;
    const body = content ?? '';
    const totalLen = header.length + body.length;
    if (patternRemaining - totalLen < 0) {
      skippedForBudget += 1;
      continue;
    }
    patternRemaining -= totalLen;
    index += 1;
    const name = contextFileName(index, candidate.repo, candidate.file, contextDir_);
    writeFileSync(join(contextDir_, name), header + body);
    contextFiles += 1;
  }

  return { jobId, dir, contextFiles, skippedForBudget };
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
