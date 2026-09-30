import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Review } from '../review/schema.js';
import type { FileDiff } from '../util/diff.js';

export interface ManifestFile {
  repo: string;
  file: string;
  packedPath: string;
  commit: string | null;
  sha256: string;
  content: string;
}
export interface SnapshotManifest {
  version: 1;
  prHead: string | null;
  diffSha256: string;
  files: ManifestFile[];
  coverage: { complete: boolean; limitations: string[] };
}
export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

export function pinCommit(repoDir: string): string | null {
  try {
    const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Read the pinned regular Git blob, never the mutable working tree when pinned. */
export function readSnapshot(repoDir: string, file: string, commit: string | null): string {
  if (
    !file ||
    isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').includes('..')
  ) {
    throw new Error('Unsafe snapshot path.');
  }
  if (commit) {
    const entry = execFileSync('git', ['-C', repoDir, 'ls-tree', '-z', commit, '--', file], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const entries = entry.split('\0').filter(Boolean);
    if (
      entries.length !== 1 ||
      !/^100(?:644|755) blob [a-f0-9]+\t/.test(entries[0]!) ||
      entries[0]!.split('\t')[1] !== file
    ) {
      throw new Error('Snapshot input must be a regular tracked blob.');
    }
    return execFileSync('git', ['-C', repoDir, 'show', `${commit}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  }
  // Local credential-free fixtures have no Git provenance. Keep them usable,
  // but explicitly mark coverage incomplete and reject links/special files.
  const root = resolve(repoDir);
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Unsafe snapshot path.');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Snapshot symlink denied.');
  }
  if (!lstatSync(path).isFile() || lstatSync(path).size > 2 * 1024 * 1024)
    throw new Error('Invalid snapshot file.');
  return readFileSync(path, 'utf8');
}

/** Host-held content and hashes are authority, never model-written manifest data. */
export function validateSnapshotReview(
  review: Review,
  manifest: SnapshotManifest,
  diffs: FileDiff[],
): Review {
  for (const file of manifest.files) {
    if (hashText(file.content) !== file.sha256) throw new Error('Snapshot content hash mismatch.');
  }
  for (const finding of review.findings) {
    const diff = diffs.find((d) => d.path === finding.file);
    if (!diff) throw new Error(`Finding cites unknown PR file: ${finding.file}`);
    if (
      finding.line !== undefined &&
      !diff.hunks.some((h) => h.lines.some((l) => l.newLine === finding.line))
    ) {
      throw new Error(`Finding cites a line outside the diff: ${finding.file}`);
    }
    for (const evidence of finding.evidence) {
      const file = manifest.files.find((f) => f.repo === evidence.repo && f.file === evidence.file);
      if (!file) throw new Error('Evidence cites a file not present in the snapshot.');
      const lines = file.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (evidence.line !== undefined && (evidence.line > lines.length || evidence.line < 1)) {
        throw new Error('Evidence line is outside the snapshot.');
      }
      if (evidence.quote !== undefined) {
        if (!evidence.quote || !file.content.includes(evidence.quote))
          throw new Error('Evidence quote is not in the snapshot.');
        if (evidence.line !== undefined && !lines[evidence.line - 1]?.includes(evidence.quote)) {
          throw new Error('Evidence quote does not match its cited line.');
        }
      }
    }
    if (finding.category === 'cross_repo' && finding.evidence.length === 0) {
      throw new Error('Cross-repo findings require snapshot evidence.');
    }
  }
  if (manifest.coverage.complete) return review;
  return {
    ...review,
    overall: 'comment',
    summary: `Limited-coverage review, not an approval or change-request verdict. ${review.summary}\nCoverage limits: ${manifest.coverage.limitations.join('; ')}.`,
  };
}

/** Recheck staged bytes after the model run; never trust a rewritten on-disk manifest. */
export function verifyPackedSnapshot(dir: string, manifest: SnapshotManifest): void {
  if (hashText(readFileSync(join(dir, 'diff.txt'), 'utf8')) !== manifest.diffSha256) {
    throw new Error('Packed diff changed during review.');
  }
  for (const file of manifest.files) {
    const expected = `# repo: ${file.repo}\n# file: ${file.file}\n${file.content}`;
    if (readFileSync(join(dir, file.packedPath), 'utf8') !== expected) {
      throw new Error('Packed evidence changed during review.');
    }
  }
}
