import { describe, expect, it } from 'vitest';

import { parseReviewText } from '../../src/review/schema.js';

const VALID_REVIEW = {
  summary: 'Adds pagination to the users endpoint.',
  overall: 'comment',
  findings: [
    {
      severity: 'warning',
      file: 'src/users.ts',
      line: 12,
      title: 'Breaks existing consumers',
      body: 'web-client expects the old shape.',
      evidence: [
        { repo: 'acme/web', file: 'src/api.ts', line: 4, quote: 'http.get("/api/users")' },
      ],
    },
  ],
};

describe('parseReviewText', () => {
  it('parses and validates a plain JSON review', () => {
    const review = parseReviewText(JSON.stringify(VALID_REVIEW));
    expect(review.overall).toBe('comment');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.evidence).toHaveLength(1);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const fenced = '```json\n' + JSON.stringify(VALID_REVIEW, null, 2) + '\n```';
    expect(parseReviewText(fenced).summary).toBe('Adds pagination to the users endpoint.');
  });

  it('defaults evidence to [] when omitted', () => {
    const review = parseReviewText(
      JSON.stringify({ summary: 'ok', overall: 'approve', findings: [{ severity: 'info', file: 'a.ts', title: 't', body: 'b' }] }),
    );
    expect(review.findings[0]?.evidence).toEqual([]);
  });

  it('accepts strengths, finding category and suggestion', () => {
    const review = parseReviewText(
      JSON.stringify({
        ...VALID_REVIEW,
        strengths: ['Good error handling'],
        findings: [
          { ...VALID_REVIEW.findings[0]!, category: 'cross_repo', suggestion: 'Update the client.' },
        ],
      }),
    );
    expect(review.strengths).toEqual(['Good error handling']);
    expect(review.findings[0]?.category).toBe('cross_repo');
    expect(review.findings[0]?.suggestion).toBe('Update the client.');
  });

  it('defaults strengths to [] when omitted', () => {
    const review = parseReviewText(JSON.stringify({ summary: 'ok', overall: 'approve', findings: [] }));
    expect(review.strengths).toEqual([]);
  });

  it('strips emoji from all model-generated text', () => {
    const review = parseReviewText(
      JSON.stringify({
        summary: 'Great ✅ work 🎉',
        overall: 'comment',
        strengths: ['Nice 🚀 improvements'],
        findings: [
          {
            severity: 'warning',
            file: 'a.ts',
            title: 'Bug 🐛',
            body: 'Fix this 🔧 issue',
            suggestion: 'Do it ✨ now',
            evidence: [{ repo: 'acme/r', file: 'f.ts', quote: 'call 💥 here' }],
          },
        ],
      }),
    );
    expect(review.summary).toBe('Great work');
    expect(review.strengths[0]).toBe('Nice improvements');
    expect(review.findings[0]?.title).toBe('Bug');
    expect(review.findings[0]?.body).toBe('Fix this issue');
    expect(review.findings[0]?.suggestion).toBe('Do it now');
    expect(review.findings[0]?.evidence[0]?.quote).toBe('call here');
  });

  it('rejects an invalid category', () => {
    expect(() =>
      parseReviewText(
        JSON.stringify({
          summary: 'x',
          overall: 'approve',
          findings: [{ severity: 'info', file: 'a.ts', title: 't', body: 'b', category: 'not-a-category' }],
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseReviewText('this is not json')).toThrow();
  });

  it('rejects objects that violate the schema', () => {
    expect(() => parseReviewText(JSON.stringify({ summary: 'x', overall: 'nope', findings: [] }))).toThrow();
    expect(() => parseReviewText(JSON.stringify({ summary: 'x', overall: 'approve' }))).toThrow();
  });

  it('rejects more than 20 findings and more than 5 evidence entries', () => {
    const findings = Array.from({ length: 21 }, (_, i) => ({
      severity: 'info' as const,
      file: 'a.ts',
      title: `t${i}`,
      body: 'b',
    }));
    expect(() => parseReviewText(JSON.stringify({ summary: 'x', overall: 'approve', findings }))).toThrow();

    const tooMuchEvidence = {
      ...VALID_REVIEW,
      findings: [{ ...VALID_REVIEW.findings[0]!, evidence: Array.from({ length: 6 }, (_, i) => ({ repo: 'acme/r', file: 'f.ts', line: i })) }],
    };
    expect(() => parseReviewText(JSON.stringify(tooMuchEvidence))).toThrow();
  });
});
