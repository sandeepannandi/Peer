import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, buildReviewSystemPrompt } from '../../src/claude/prompt.js';

describe('buildReviewSystemPrompt', () => {
  it('includes the reviewer identity and the output schema', () => {
    const prompt = buildReviewSystemPrompt();

    expect(prompt).toContain('cross-repo code review');
    expect(prompt).toContain('"overall"');
    expect(prompt).toContain('changes_requested');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('At most 20 findings');
    expect(prompt).toContain('"strengths"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"suggestion"');
  });
});

describe('buildReviewPrompt', () => {
  it('points at the PR, the numbered diff and the context pack', () => {
    const prompt = buildReviewPrompt({
      owner: 'acme',
      repo: 'api',
      prNumber: 42,
      title: 'Add pagination',
      baseRef: 'main',
      contextFiles: 3,
    });

    expect(prompt).toContain('pull request #42 in acme/api');
    expect(prompt).toContain('"Add pagination"');
    expect(prompt).toContain('base branch: main');
    expect(prompt).toContain('diff.txt');
    expect(prompt).toContain('context/');
    expect(prompt).toContain('3 files');
    expect(prompt).toContain('new-file line number');
  });
});
