import { describe, expect, it } from 'vitest';

import { buildReviewMarkdown, formatReview } from '../../src/review/format.js';
import type { Finding, Review } from '../../src/review/schema.js';
import { parseUnifiedDiff } from '../../src/util/diff.js';

const DIFF = [
  'diff --git a/src/api.ts b/src/api.ts',
  '--- a/src/api.ts',
  '+++ b/src/api.ts',
  '@@ -1,1 +1,3 @@',
  ' export function listUsers() {',
  '+  return http.get("/api/v2/users");',
  '+}',
].join('\n');

const files = parseUnifiedDiff(DIFF);

function review(overall: Review['overall'] = 'comment', findings: Finding[] = []): Review {
  return { summary: 'Summary', overall, findings };
}

describe('formatReview', () => {
  it('anchors a finding with a valid new-file line as an inline comment', () => {
    const finding: Finding = {
      severity: 'error',
      file: 'src/api.ts',
      line: 2,
      title: 'Broken contract',
      body: 'Consumers expect the old shape.',
      evidence: [{ repo: 'acme/web', file: 'src/client.ts', line: 4, quote: 'getUsers()' }],
    };

    const result = formatReview(review('changes_requested', [finding]), files, 20);

    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ path: 'src/api.ts', line: 2, side: 'RIGHT' });
    expect(result.comments[0]!.body).toContain('Broken contract');
    expect(result.comments[0]!.body).toContain('acme/web/src/client.ts:4');
    expect(result.dropped).toEqual([]);
  });

  it('drops findings without a line or with a line outside the hunks into the body', () => {
    const findings: Finding[] = [
      { severity: 'warning', file: 'src/api.ts', title: 'File-level', body: 'No line.', evidence: [] },
      { severity: 'info', file: 'src/api.ts', line: 99, title: 'Out of range', body: 'Not in diff.', evidence: [] },
    ];

    const result = formatReview(review('comment', findings), files, 20);

    expect(result.comments).toEqual([]);
    expect(result.dropped).toHaveLength(2);
    expect(result.body).toContain('File-level');
    expect(result.body).toContain('Out of range');
    expect(result.event).toBe('COMMENT');
  });

  it('dedupes identical comments and caps at MAX_REVIEW_COMMENTS', () => {
    const finding: Finding = {
      severity: 'warning',
      file: 'src/api.ts',
      line: 2,
      title: 'Same issue',
      body: 'Duplicate body.',
      evidence: [],
    };
    const reviewWithDuplicates = review('comment', [finding, finding, finding]);

    const result = formatReview(reviewWithDuplicates, files, 1);

    expect(result.comments).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
  });

  it('maps overall to the GitHub review event', () => {
    expect(formatReview(review('changes_requested'), files, 20).event).toBe('REQUEST_CHANGES');
    expect(formatReview(review('comment'), files, 20).event).toBe('COMMENT');
    expect(formatReview(review('approve'), files, 20).event).toBe('COMMENT');
  });
});

describe('buildReviewMarkdown', () => {
  it('renders a readable local report with all findings', () => {
    const finding: Finding = {
      severity: 'error',
      file: 'src/api.ts',
      line: 2,
      title: 'T',
      body: 'B',
      evidence: [{ repo: 'acme/web', file: 'src/client.ts', line: 4 }],
    };

    const md = buildReviewMarkdown(review('changes_requested', [finding]), files, 20);

    expect(md).toContain('# Code Review');
    expect(md).toContain('## [error] T');
    expect(md).toContain('src/api.ts:2');
    expect(md).toContain('acme/web/src/client.ts');
  });
});
