import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { Db } from '../store/db.js';
import { JS_SYMBOL_RULES, type SymbolRule } from '../util/symbols.js';
import {
  clearRepoFiles,
  getRepoId,
  insertFile,
  insertSymbol,
  listReposByOwner,
  markRepoIndexed,
} from '../store/db.js';

const MAX_SYMBOL_FILE_BYTES = 512 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.java': 'java',
};

const SYMBOL_RULES: Record<string, SymbolRule[]> = {
  js: JS_SYMBOL_RULES,
  ts: JS_SYMBOL_RULES,
  py: [
    { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class', re: /^class\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s/ },
  ],
  java: [
    { kind: 'class', re: /^(?:public\s+|final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', re: /^(?:public\s+)?interface\s+([A-Za-z_]\w*)/ },
  ],
};

export interface Symbol {
  kind: string;
  name: string;
  line: number;
}

export function extractSymbols(lang: string, content: string): Symbol[] {
  const rules = SYMBOL_RULES[lang];
  if (!rules) return [];

  const symbols: Symbol[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of rules) {
      const match = rule.re.exec(line);
      if (match?.[1]) {
        symbols.push({ kind: rule.kind, name: match[1], line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}

function langForExt(filePath: string): string | null {
  return LANG_BY_EXT[extname(filePath).toLowerCase()] ?? null;
}

export function walkFiles(dir: string): string[] {
  const files: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

export function readFileUtf8(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null; // unreadable file
  }
}

export interface IndexResult {
  repo: string;
  files: number;
  symbols: number;
}

export interface IndexOutcome {
  repos: IndexResult[];
  skipped: string[];
}

export function indexRepos(db: Db, mirrorRoot: string, owner: string): IndexOutcome {
  const repos = listReposByOwner(db, owner);
  if (repos.length === 0) {
    throw new Error(`No repos recorded for "${owner}" — run "peer mirror --owner ${owner}" first.`);
  }

  const outcome: IndexOutcome = { repos: [], skipped: [] };
  for (const repo of repos) {
    const repoDir = join(mirrorRoot, repo.owner, repo.name);
    if (!existsSync(repoDir)) {
      outcome.skipped.push(`${repo.owner}/${repo.name} (mirror directory missing)`);
      continue;
    }

    // Full re-index per repo, atomic in one transaction.
    const indexRepo = db.transaction(() => {
      const repoId = getRepoId(db, repo.owner, repo.name);
      if (repoId === undefined) {
        throw new Error(`Repo ${repo.owner}/${repo.name} is not recorded in the DB.`);
      }
      clearRepoFiles(db, repoId);

      let files = 0;
      let symbols = 0;
      for (const filePath of walkFiles(repoDir)) {
        const rel = relative(repoDir, filePath).split(sep).join('/');
        const size = statSync(filePath).size;
        const lang = langForExt(filePath);
        const fileId = insertFile(db, repoId, {
          path: rel,
          basename: basename(filePath),
          lang,
          size,
        });
        files += 1;

        if (lang !== null && size <= MAX_SYMBOL_FILE_BYTES) {
          const content = readFileUtf8(filePath);
          if (content !== null && !content.includes('\u0000')) {
            for (const symbol of extractSymbols(lang, content)) {
              insertSymbol(db, fileId, symbol);
              symbols += 1;
            }
          }
        }
      }
      markRepoIndexed(db, repoId);
      return { files, symbols };
    });

    outcome.repos.push({ repo: `${repo.owner}/${repo.name}`, ...indexRepo() });
  }
  return outcome;
}
