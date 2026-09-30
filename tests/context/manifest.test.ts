import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashText,
  pinCommit,
  readSnapshot,
  validateSnapshotReview,
  verifyPackedSnapshot,
  type SnapshotManifest,
} from '../../src/context/manifest.js';
import { parseReviewText, type Review } from '../../src/review/schema.js';
import { parseUnifiedDiff } from '../../src/util/diff.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-manifest-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const diffs = parseUnifiedDiff(
  'diff --git a/api.ts b/api.ts\n--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-old\n+new\n',
);
const content = 'consumer\nexact quote\n';
const manifest = (): SnapshotManifest => ({
  version: 1,
  prHead: 'a'.repeat(40),
  diffSha256: 'hash',
  files: [
    {
      repo: 'org/client',
      file: 'client.ts',
      packedPath: 'context/01',
      commit: 'b'.repeat(40),
      sha256: hashText(content),
      content,
    },
  ],
  coverage: { complete: false, limitations: ['heuristic retrieval'] },
});
const review = (): Review => ({
  summary: 'ok',
  overall: 'approve',
  strengths: [],
  findings: [
    {
      file: 'api.ts',
      line: 1,
      severity: 'warning',
      category: 'cross_repo',
      title: 'change',
      body: 'risk',
      evidence: [{ repo: 'org/client', file: 'client.ts', line: 2, quote: 'exact quote' }],
    },
  ],
});

describe('snapshot provenance and citations', () => {
  it('reads pinned Git content even when working tree content changes', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'client.ts'), content);
    git('add', '.');
    git('commit', '-m', 'snapshot');
    const sha = pinCommit(root)!;
    writeFileSync(join(root, 'client.ts'), 'changed');
    expect(readSnapshot(root, 'client.ts', sha)).toBe(content);
  });
  it('denies local fixture symlinks and traversal', () => {
    writeFileSync(join(root, 'source'), content);
    symlinkSync(join(root, 'source'), join(root, 'link'));
    expect(() => readSnapshot(root, 'link', null)).toThrow();
    expect(() => readSnapshot(root, '../source', null)).toThrow();
    expect(() => readSnapshot(root, '/etc/passwd', null)).toThrow();
  });
  it('rejects a committed symlink instead of treating it as evidence', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'source'), content);
    symlinkSync('source', join(root, 'link'));
    git('add', '.');
    git('commit', '-m', 'links');
    expect(() => readSnapshot(root, 'link', pinCommit(root))).toThrow();
  });
  it('validates a real citation but downgrades any confident verdict under incomplete coverage', () => {
    for (const overall of ['approve', 'changes_requested'] as const) {
      const checked = validateSnapshotReview({ ...review(), overall }, manifest(), diffs);
      expect(checked.overall).toBe('comment');
      expect(checked.summary).toContain('Coverage limits');
    }
  });
  it.each(['repo', 'file', 'line', 'quote'])('rejects invented evidence %s', (field) => {
    const value = review();
    const e = value.findings[0]!.evidence[0]!;
    if (field === 'repo') e.repo = 'org/invented';
    if (field === 'file') e.file = 'invented.ts';
    if (field === 'line') e.line = 500;
    if (field === 'quote') e.quote = 'not in file';
    expect(() => validateSnapshotReview(value, manifest(), diffs)).toThrow();
  });
  it('rejects a valid quote at the wrong line and unknown finding anchors', () => {
    const value = review();
    value.findings[0]!.evidence[0]!.line = 1;
    expect(() => validateSnapshotReview(value, manifest(), diffs)).toThrow();
    value.findings[0]!.evidence = [];
    value.findings[0]!.file = 'invented.ts';
    expect(() => validateSnapshotReview(value, manifest(), diffs)).toThrow();
    value.findings[0]!.file = 'api.ts';
    value.findings[0]!.line = 999;
    expect(() => validateSnapshotReview(value, manifest(), diffs)).toThrow();
  });
  it('rejects missing cross-repo evidence and tampered source content', () => {
    const value = review();
    value.findings[0]!.evidence = [];
    expect(() => validateSnapshotReview(value, manifest(), diffs)).toThrow();
    const changed = manifest();
    changed.files[0]!.content = 'tampered';
    expect(() => validateSnapshotReview(review(), changed, diffs)).toThrow();
  });
  it.each([-1, 0, 1.5])('rejects invalid schema line %s', (line) => {
    const value = review();
    value.findings[0]!.line = line;
    expect(() => parseReviewText(JSON.stringify(value))).toThrow();
  });
  it('keeps exact evidence quotes and file identities when cleaning prose', () => {
    const value = review();
    value.findings[0]!.evidence[0]!.quote = 'a  b';
    expect(parseReviewText(JSON.stringify(value)).findings[0]!.evidence[0]!.quote).toBe('a  b');
  });
  it('detects staged content changes without trusting the on-disk manifest', () => {
    const value = manifest();
    writeFileSync(join(root, 'diff.txt'), 'diff');
    value.diffSha256 = hashText('diff');
    mkdirSync(join(root, 'context'));
    writeFileSync(join(root, 'context', '01'), `# repo: org/client\n# file: client.ts\n${content}`);
    verifyPackedSnapshot(root, value);
    writeFileSync(join(root, 'context', '01'), 'modified');
    expect(() => verifyPackedSnapshot(root, value)).toThrow('evidence changed');
  });

  it('marks plain local fixture sources unpinned', () => {
    mkdirSync(join(root, 'context'));
    expect(pinCommit(root)).toBeNull();
  });
});
