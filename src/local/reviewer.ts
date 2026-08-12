import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSymbols } from '../mirror/indexer.js';
import type { Finding, Review } from '../review/schema.js';
import type { FileDiff } from '../util/diff.js';

/** Deterministic local reviewer: finds symbols added in the diff that also appear in the context pack. */

interface ContextFile {
  repo: string;
  file: string;
  content: string;
}

export function runLocalReviewer(workspaceDir: string, files: FileDiff[], prLabel: string): Review {
  const context = readContextFiles(join(workspaceDir, 'context'));
  const findings: Finding[] = [];

  for (const file of files) {
    if (!file.path) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== 'added' || line.newLine === undefined) continue;
        for (const symbol of extractSymbols('ts', line.text)) {
          const matches = context.filter((c) => c.content.includes(symbol.name));
          if (matches.length === 0) continue;
          findings.push({
            severity: 'warning',
            file: file.path,
            line: line.newLine,
            title: `Symbol ${symbol.name} is also used in other repositories`,
            body: 'This symbol added in the PR also appears in files from other repos in the context pack — verify the change does not break those consumers.',
            evidence: matches.slice(0, 5).map((c) => ({
              repo: c.repo,
              file: c.file,
              quote: firstLineWith(c.content, symbol.name),
            })),
          });
          break; // one finding per line
        }
      }
    }
  }

  return {
    summary: `Local fixture review of ${prLabel}: ${files.length} file(s) changed, ${context.length} context file(s) examined.`,
    overall: findings.length > 0 ? 'changes_requested' : 'approve',
    findings,
  };
}

function readContextFiles(contextDir: string): ContextFile[] {
  if (!existsSync(contextDir)) return [];
  return readdirSync(contextDir).map((name) => {
    const content = readFileSync(join(contextDir, name), 'utf8');
    return {
      repo: content.match(/^# repo: (.+)$/m)?.[1] ?? '',
      file: content.match(/^# file: (.+)$/m)?.[1] ?? name,
      content,
    };
  });
}

function firstLineWith(content: string, needle: string): string | undefined {
  return content.split('\n').find((line) => line.includes(needle))?.trim();
}
