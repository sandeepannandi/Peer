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

  // Pattern files always get a slot (up to the budget) — they encode conventions.
  const patternFiles: ContextCandidate[] = [];
  for (const repo of repos) {
    if (repo.name === prRepo) continue;
    for (const name of PATTERN_FILES) {
      if (existsSync(join(mirrorRoot, repo.owner, repo.name, name))) {
        patternFiles.push({
          repo: `${repo.owner}/${repo.name}`,
          file: name,
          score: Number.MAX_SAFE_INTEGER,
          via: ['pattern'],
        });
      }
    }
  }

  const candidates = findContextFiles(db, mirrorRoot, owner, prRepo, probes, maxFiles);

  // Patterns first; duplicates keep the first occurrence.
  const seen = new Set<string>();
  const ordered: ContextCandidate[] = [];
  for (const candidate of [...patternFiles, ...candidates]) {
    const key = `${candidate.repo}/${candidate.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  ordered.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  let remaining = budgetChars;
  let contextFiles = 0;
  let skippedForBudget = 0;
  let index = 0;

  for (const candidate of ordered) {
    const repoName = candidate.repo.slice(candidate.repo.indexOf('/') + 1);
    const abs = join(mirrorRoot, owner, repoName, candidate.file);

    // Size guard first — a candidate larger than the remaining budget can't fit.
    let content: string | null;
    try {
      if (statSync(abs).size > remaining) {
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
    if (remaining - header.length - body.length < 0) {
      skippedForBudget += 1;
      continue;
    }
    remaining -= header.length + body.length;
    index += 1;
    const name = contextFileName(index, candidate.repo, candidate.file, contextDir);
    writeFileSync(join(contextDir, name), header + body);
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
