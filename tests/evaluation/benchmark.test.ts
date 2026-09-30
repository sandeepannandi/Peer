import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashText } from '../../src/context/manifest.js';
import {
  evaluateRetrieval,
  loadEvaluationSet,
  scoreReviews,
} from '../../src/evaluation/benchmark.js';

const data = loadEvaluationSet('benchmarks/cross-repo-v1.json');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'peer-score-'));
  roots.push(root);
  return root;
}
function inputs() {
  const root = temp();
  const cases: Record<
    string,
    { reviewFile: string; matches: { findingIndex: number; labelId: string }[] }
  > = {};
  for (const c of data.cases) {
    const reviewFile = `${c.id}.json`;
    cases[c.id] = {
      reviewFile,
      matches: c.labels.map((l, findingIndex) => ({ findingIndex, labelId: l.id })),
    };
    writeFileSync(
      join(root, reviewFile),
      JSON.stringify({
        summary: 'Synthetic test oracle, not model output',
        overall: 'comment',
        findings: c.labels.map((l) => ({
          file: l.file,
          line: l.line,
          severity: 'warning',
          category: l.category,
          title: l.rationale,
          body: l.rationale,
          evidence: [l.evidence],
        })),
      }),
    );
  }
  const judgments = {
    run: {
      model: 'test-oracle',
      promptSha256: '0'.repeat(64),
      runnerRevision: 'unit-test',
      limits: 'no model call',
    },
    adjudicator: 'Unit test oracle, not a human benchmark result',
    reviewedAt: '2026-09-30T00:00:00Z',
    datasetSha256: hashText(JSON.stringify(data)),
    cases,
  };
  const path = join(root, 'judgments.json');
  return { root, path, judgments, save: () => writeFileSync(path, JSON.stringify(judgments)) };
}
describe('labelled cross-repo benchmark', () => {
  it('keeps versioned positive and negative controls with explicit injection data', () => {
    expect(data.version).toBe(1);
    expect(data.cases).toHaveLength(11);
    expect(data.cases.filter((c) => c.labels.length)).toHaveLength(5);
    expect(
      data.cases.find((c) => c.id === 'injection-control')?.files['consumer/README.md'],
    ).toContain('untrusted');
  });
  it('retrieves all five labelled sources without claiming model accuracy or complete coverage', () => {
    const result = evaluateRetrieval(data);
    expect(result.retrievedLabels).toBe(5);
    expect(result.retrievalRecall).toBe(1);
    expect(result.modelAccuracy).toBe('NOT RUN');
    expect(result.rows.every((r) => !r.coverageComplete)).toBe(true);
    expect(result.rows.filter((r) => !r.expected)).toHaveLength(6);
  });
  it.each([
    '../escape.ts',
    '/absolute.ts',
    'consumer/../escape.ts',
    'consumer/./src.ts',
    'consumer\\escape.ts',
  ])('rejects unsafe fixture path %s', (path) => {
    const clone = structuredClone(data);
    clone.cases[0]!.files[path] = 'x';
    const file = join(temp(), 'dataset.json');
    writeFileSync(file, JSON.stringify(clone));
    expect(() => loadEvaluationSet(file)).toThrow(/Unsafe/);
  });
  it('rejects duplicate ids and evidence drift', () => {
    const clone = structuredClone(data);
    const file = join(temp(), 'dataset.json');
    clone.cases.push(clone.cases[0]!);
    writeFileSync(file, JSON.stringify(clone));
    expect(() => loadEvaluationSet(file)).toThrow(/Duplicate/);
    clone.cases.pop();
    clone.cases[0]!.labels[0]!.evidence.quote = 'not real';
    writeFileSync(file, JSON.stringify(clone));
    expect(() => loadEvaluationSet(file)).toThrow(/evidence absent/);
  });
  it('scores a test oracle only when adjudication, anchors and citations match', () => {
    const input = inputs();
    input.save();
    const result = scoreReviews(data, input.path);
    expect(result).toMatchObject({ tp: 5, fp: 0, fn: 0, precision: 1, recall: 1 });
  });
  it('counts duplicate findings as false positives rather than extra true positives', () => {
    const input = inputs();
    const path = join(input.root, 'parameter-break.json');
    const review = JSON.parse(readFileSync(path, 'utf8'));
    review.findings.push(review.findings[0]);
    writeFileSync(path, JSON.stringify(review));
    input.save();
    expect(scoreReviews(data, input.path)).toMatchObject({ tp: 5, fp: 1, fn: 0, precision: 5 / 6 });
    input.judgments.cases['parameter-break']!.matches.push({
      findingIndex: 1,
      labelId: data.cases[0]!.labels[0]!.id,
    });
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow(/duplicate adjudication/);
  });
  it('counts misses and negative-control findings', () => {
    const input = inputs();
    const path = join(input.root, 'parameter-break.json');
    const review = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(join(input.root, 'parameter-safe.json'), JSON.stringify(review));
    review.findings = [];
    writeFileSync(path, JSON.stringify(review));
    input.judgments.cases['parameter-break']!.matches = [];
    input.save();
    expect(scoreReviews(data, input.path)).toMatchObject({
      tp: 4,
      fp: 1,
      fn: 1,
      precision: 0.8,
      recall: 0.8,
    });
  });
  it('requires every case and the exact dataset hash', () => {
    const input = inputs();
    input.judgments.datasetSha256 = '0'.repeat(64);
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow(/hash mismatch/);
    input.judgments.datasetSha256 = hashText(JSON.stringify(data));
    delete input.judgments.cases['route-safe'];
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow(/Missing adjudication/);
  });
  it('rejects a forged quote even when a human match was entered', () => {
    const input = inputs();
    const path = join(input.root, 'parameter-break.json');
    const review = JSON.parse(readFileSync(path, 'utf8'));
    review.findings[0].evidence[0].quote = 'fabricated';
    writeFileSync(path, JSON.stringify(review));
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow(/quote/);
  });
  it('rejects a semantic match without the labelled anchor and evidence', () => {
    const input = inputs();
    const path = join(input.root, 'parameter-break.json');
    const review = JSON.parse(readFileSync(path, 'utf8'));
    delete review.findings[0].line;
    writeFileSync(path, JSON.stringify(review));
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow(/labelled anchor/);
  });
  it('rejects saved-review paths outside the adjudication directory', () => {
    const input = inputs();
    input.judgments.cases['parameter-break']!.reviewFile = '../outside.json';
    input.save();
    expect(() => scoreReviews(data, input.path)).toThrow();
  });
});
