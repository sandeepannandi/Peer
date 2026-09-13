import { describe, expect, it } from 'vitest';
import { buildNumberedDiff, parseUnifiedDiff } from '../../src/util/diff.js';

describe('parseUnifiedDiff', () => {
  it('parses a single-file diff with context, added and removed lines', () => {
    const raw = [
      'diff --git a/src/api.ts b/src/api.ts',
      'index 1111111..2222222 100644',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,3 +1,4 @@',
      ' import { http } from "./http";',
      ' export function listUsers() {',
      '-  return http.get("/api/users");',
      '+  return http.get("/api/v2/users");',
      '+}',
    ].join('\n');

    const [file] = parseUnifiedDiff(raw);

    expect(file?.path).toBe('src/api.ts');
    expect(file?.oldPath).toBe('src/api.ts');
    expect(file?.hunks).toHaveLength(1);

    const hunk = file!.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(hunk.lines).toEqual([
      { kind: 'context', text: 'import { http } from "./http";', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'export function listUsers() {', oldLine: 2, newLine: 2 },
      { kind: 'removed', text: '  return http.get("/api/users");', oldLine: 3 },
      { kind: 'added', text: '  return http.get("/api/v2/users");', newLine: 3 },
      { kind: 'added', text: '}', newLine: 4 },
    ]);
  });

  it('handles new files, deleted files and multiple hunks', () => {
    const raw = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const fresh = 1;',
      '+export function freshFn() {}',
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      'index 0000000..7654321',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export const dead = 1;',
      '-export function deadFn() {}',
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,2 +1,2 @@',
      '-const A = 1;',
      '+const A = 2;',
      '@@ -10,2 +10,3 @@',
      ' export function z() {',
      '+  return 1;',
      ' }',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(3);

    expect(files[0]).toMatchObject({ oldPath: null, path: 'src/new.ts' });
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'added', text: 'export const fresh = 1;', newLine: 1 },
      { kind: 'added', text: 'export function freshFn() {}', newLine: 2 },
    ]);

    expect(files[1]).toMatchObject({ oldPath: 'old.ts', path: null });
    expect(files[1]?.hunks[0]?.lines).toEqual([
      { kind: 'removed', text: 'export const dead = 1;', oldLine: 1 },
      { kind: 'removed', text: 'export function deadFn() {}', oldLine: 2 },
    ]);

    expect(files[2]?.hunks).toHaveLength(2);
    const secondHunk = files[2]?.hunks[1];
    expect(secondHunk).toMatchObject({ newStart: 10, newLines: 3 });
    expect(secondHunk?.lines).toEqual([
      { kind: 'context', text: 'export function z() {', oldLine: 10, newLine: 10 },
      { kind: 'added', text: '  return 1;', newLine: 11 },
      { kind: 'context', text: '}', oldLine: 11, newLine: 12 },
    ]);
  });
});

describe('buildNumberedDiff', () => {
  it('annotates new-file line numbers and blanks removed lines', () => {
    const raw = [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,3 +1,4 @@',
      ' import { http } from "./http";',
      ' export function listUsers() {',
      '-  return http.get("/api/users");',
      '+  return http.get("/api/v2/users");',
      '+}',
    ].join('\n');

    expect(buildNumberedDiff(parseUnifiedDiff(raw))).toBe(
      [
        '--- a/src/api.ts',
        '+++ b/src/api.ts',
        '@@ -1,3 +1,4 @@',
        '     1|  import { http } from "./http";',
        '     2|  export function listUsers() {',
        '      | -  return http.get("/api/users");',
        '     3| +  return http.get("/api/v2/users");',
        '     4| +}',
      ].join('\n'),
    );
  });

  it('keeps line numbers correct across multiple hunks', () => {
    const raw = [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,2 +1,2 @@',
      '-const A = 1;',
      '+const A = 2;',
      '@@ -10,2 +10,3 @@',
      ' export function z() {',
      '+  return 1;',
      ' }',
    ].join('\n');

    const numbered = buildNumberedDiff(parseUnifiedDiff(raw));
    expect(numbered).toBe(
      [
        '--- a/src/api.ts',
        '+++ b/src/api.ts',
        '@@ -1,2 +1,2 @@',
        '      | -const A = 1;',
        '     1| +const A = 2;',
        '@@ -10,2 +10,3 @@',
        '    10|  export function z() {',
        '    11| +  return 1;',
        '    12|  }',
      ].join('\n'),
    );
  });
});
