import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readFileUtf8, walkFiles } from '../mirror/indexer.js';
import { listReposByOwner, type Db } from '../store/db.js';
import type { Probes } from './probes.js';

export interface ContextCandidate {
  repo: string; // org/repo
  file: string;
  score: number;
  via: string[];
}

const WEIGHTS = { symbol: 3, basename: 2, content: 1 };
const MAX_CONTENT_SCAN_BYTES = 512 * 1024;
const MAX_CONTENT_TERMS = 15;
const MAX_FILES_PER_REPO_SCAN = 1000;

export function findContextFiles(
  db: Db,
  mirrorRoot: string,
  owner: string,
  prRepo: string,
  probes: Probes,
  maxFiles: number,
): ContextCandidate[] {
  const byFile = new Map<string, ContextCandidate>();

  const bump = (repo: string, file: string, weight: number, via: string) => {
    const key = `${repo}/${file}`;
    const existing = byFile.get(key);
    if (existing) {
      existing.score += weight;
      if (!existing.via.includes(via)) existing.via.push(via);
    } else {
      byFile.set(key, { repo, file, score: weight, via: [via] });
    }
  };

  // 1. Symbol index matches (SQL).
  if (probes.symbols.length > 0) {
    const placeholders = probes.symbols.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT r.name AS repo, f.path AS file, COUNT(DISTINCT s.name) AS hits
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         JOIN repos r ON r.id = f.repo_id
         WHERE r.owner = ? AND r.name <> ? AND s.name IN (${placeholders})
         GROUP BY f.id`,
      )
      .all(owner, prRepo, ...probes.symbols) as Array<{ repo: string; file: string; hits: number }>;
    for (const row of rows) {
      bump(`${owner}/${row.repo}`, row.file, WEIGHTS.symbol * row.hits, 'symbol');
    }
  }

  // 2. Basename matches (SQL).
  if (probes.basenames.length > 0) {
    const placeholders = probes.basenames.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT r.name AS repo, f.path AS file, COUNT(*) AS hits
         FROM files f
         JOIN repos r ON r.id = f.repo_id
         WHERE r.owner = ? AND r.name <> ? AND f.basename IN (${placeholders})
         GROUP BY f.id`,
      )
      .all(owner, prRepo, ...probes.basenames) as Array<{ repo: string; file: string; hits: number }>;
    for (const row of rows) {
      bump(`${owner}/${row.repo}`, row.file, WEIGHTS.basename * row.hits, 'basename');
    }
  }

  // 3. Content hits — Node walk over the mirror (rg is an optional fallback).
  const terms = contentTerms(probes);
  if (terms.length > 0) {
    for (const repo of listReposByOwner(db, owner)) {
      if (repo.name === prRepo) continue;
      const repoDir = join(mirrorRoot, repo.owner, repo.name);
      if (!existsSync(repoDir)) continue;

      let scanned = 0;
      for (const abs of walkFiles(repoDir)) {
        if (scanned++ >= MAX_FILES_PER_REPO_SCAN) break;
        const content = readFileUtf8(abs);
        if (content === null || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SCAN_BYTES) continue;

        const lower = content.toLowerCase();
        let hits = 0;
        for (const term of terms) {
          if (lower.includes(term)) hits += 1;
        }
        if (hits > 0) {
          const rel = relative(repoDir, abs).split(sep).join('/');
          bump(`${owner}/${repo.name}`, rel, WEIGHTS.content * hits, 'content');
        }
      }
    }
  }

  const prefix = (label: string) => label.slice(label.indexOf('/') + 1).split(/[-_.]/)[0] ?? '';
  const prPrefix = prefix(prRepo);

  const candidates = [...byFile.values()];
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(prefix(a.repo) === prPrefix) - Number(prefix(b.repo) === prPrefix) ||
      a.repo.localeCompare(b.repo) ||
      a.file.localeCompare(b.file),
  );
  return candidates.slice(0, maxFiles);
}

function contentTerms(probes: Probes): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const probe of [...probes.routes, ...probes.tables, ...probes.imports, ...probes.symbols]) {
    if (probe.length < 3) continue;
    const key = probe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
    if (terms.length >= MAX_CONTENT_TERMS) break;
  }
  return terms;
}
