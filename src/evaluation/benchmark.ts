import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { hashText, validateSnapshotReview } from '../context/manifest.js';
import { buildContextPack } from '../context/pack.js';
import { extractProbes } from '../context/probes.js';
import { indexRepos } from '../mirror/indexer.js';
import { parseReviewText } from '../review/schema.js';
import { openDb, upsertRepo } from '../store/db.js';
import { buildNumberedDiff, parseUnifiedDiff } from '../util/diff.js';

const Evidence = z.object({
  repo: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  quote: z.string().min(1),
});
const Label = z.object({
  id: z.string().min(1),
  file: z.string(),
  line: z.number().int().positive(),
  category: z.literal('cross_repo'),
  evidence: Evidence,
  rationale: z.string().min(1),
  kind: z.enum(['contract', 'duplicate']),
});
const Case = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  diff: z.string(),
  files: z.record(z.string(), z.string()),
  labels: z.array(Label),
  notes: z.string(),
});
const Dataset = z.object({
  version: z.literal(1),
  provenance: z.string(),
  cases: z.array(Case).min(1),
});
// These mappings must be human-adjudicated, not generated from finding anchors.
const Judgments = z.object({
  adjudicator: z.string().min(1),
  reviewedAt: z.string().datetime(),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  run: z.object({
    model: z.string().min(1),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerRevision: z.string().min(1),
    limits: z.string().min(1),
  }),
  cases: z.record(
    z.string(),
    z.object({
      reviewFile: z.string().regex(/^[a-z0-9-]+\.json$/),
      matches: z.array(
        z.object({ findingIndex: z.number().int().nonnegative(), labelId: z.string() }),
      ),
    }),
  ),
});
export type EvaluationSet = z.infer<typeof Dataset>;

export function loadEvaluationSet(path: string): EvaluationSet {
  const data = Dataset.parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  for (const c of data.cases) {
    if (ids.has(c.id)) throw new Error('Duplicate evaluation case id.');
    ids.add(c.id);
    if (!c.files['service/src/api.ts'] || !c.files['consumer/src/client.ts'])
      throw new Error('Missing required fixture source.');
    for (const file of Object.keys(c.files)) {
      if (
        isAbsolute(file) ||
        file.includes('\\') ||
        file.includes('\0') ||
        file.split('/').some((part) => !part || part === '.') ||
        file.split('/').includes('..') ||
        !/^(service|consumer)\//.test(file)
      )
        throw new Error('Unsafe fixture path.');
    }
    const labels = new Set<string>();
    const diffs = parseUnifiedDiff(c.diff);
    for (const l of c.labels) {
      if (labels.has(l.id)) throw new Error('Duplicate label id.');
      labels.add(l.id);
      if (
        !diffs.some(
          (d) =>
            d.path === l.file &&
            d.hunks.some((h) => h.lines.some((line) => line.newLine === l.line)),
        )
      )
        throw new Error('Label anchor absent from diff.');
      if (l.evidence.repo !== 'eval/consumer') throw new Error('Label must cite eval/consumer.');
      const source = c.files[`${l.evidence.repo.split('/')[1]}/${l.evidence.file}`];
      if (!source?.split('\n')[l.evidence.line - 1]?.includes(l.evidence.quote))
        throw new Error('Label evidence absent from fixture.');
    }
  }
  return data;
}

/** Offline retrieval/packing coverage, NOT model precision or semantic recall. */
export function evaluateRetrieval(data: EvaluationSet) {
  const root = mkdtempSync(join(tmpdir(), 'peer-eval-'));
  const rows: {
    id: string;
    expected: number;
    retrieved: number;
    contextFiles: number;
    coverageComplete: boolean;
  }[] = [];
  try {
    for (const c of data.cases) {
      const dir = join(root, c.id);
      const mirror = join(dir, 'mirror');
      for (const [file, content] of Object.entries(c.files)) {
        const path = join(mirror, 'eval', file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      const db = openDb(join(dir, 'index.db'));
      try {
        for (const repo of ['service', 'consumer'])
          upsertRepo(db, { owner: 'eval', name: repo, defaultBranch: 'main' });
        indexRepos(db, mirror, 'eval');
        const diffs = parseUnifiedDiff(c.diff);
        const pack = buildContextPack({
          db,
          mirrorRoot: mirror,
          owner: 'eval',
          prRepo: 'service',
          numberedDiff: buildNumberedDiff(diffs),
          probes: extractProbes(diffs),
          workspaceRoot: join(dir, 'workspace'),
        });
        const retrieved = c.labels.filter((l) =>
          pack.manifest.files.some(
            (f) =>
              f.repo === l.evidence.repo &&
              f.file === l.evidence.file &&
              f.content.includes(l.evidence.quote),
          ),
        ).length;
        rows.push({
          id: c.id,
          expected: c.labels.length,
          retrieved,
          contextFiles: pack.contextFiles,
          coverageComplete: pack.manifest.coverage.complete,
        });
      } finally {
        db.close();
      }
    }
    const expected = rows.reduce((n, r) => n + r.expected, 0);
    const retrieved = rows.reduce((n, r) => n + r.retrieved, 0);
    return {
      mode: 'offline-retrieval-only',
      datasetVersion: data.version,
      datasetSha256: hashText(JSON.stringify(data)),
      cases: rows.length,
      labels: expected,
      retrievedLabels: retrieved,
      retrievalRecall: expected ? retrieved / expected : null,
      modelAccuracy: 'NOT RUN',
      rows,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Score saved model reviews only with explicit human semantic adjudication. */
export function scoreReviews(data: EvaluationSet, judgmentsPath: string) {
  const judgments = Judgments.parse(JSON.parse(readFileSync(judgmentsPath, 'utf8')));
  if (judgments.datasetSha256 !== hashText(JSON.stringify(data)))
    throw new Error('Adjudication dataset hash mismatch.');
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const rows: { id: string; tp: number; fp: number; fn: number }[] = [];
  for (const c of data.cases) {
    const judgment = judgments.cases[c.id];
    if (!judgment) throw new Error(`Missing adjudication for ${c.id}; no partial benchmark score.`);
    const review = parseReviewText(
      readFileSync(join(dirname(judgmentsPath), judgment.reviewFile), 'utf8'),
    );
    const files = Object.entries(c.files)
      .filter(([file]) => file.startsWith('consumer/'))
      .map(([file, content]) => ({
        repo: 'eval/consumer',
        file: file.slice('consumer/'.length),
        packedPath: '',
        commit: null,
        sha256: '',
        content,
      }));
    // Citation validation requires exact source hashes, even for scored saved replies.
    for (const file of files) file.sha256 = hashText(file.content);
    validateSnapshotReview(
      review,
      {
        version: 1,
        prHead: null,
        diffSha256: '',
        files,
        coverage: { complete: false, limitations: ['synthetic'] },
      },
      parseUnifiedDiff(c.diff),
    );
    const findings = new Set<number>();
    const matched = new Set<string>();
    for (const match of judgment.matches) {
      if (
        !review.findings[match.findingIndex] ||
        !c.labels.some((l) => l.id === match.labelId) ||
        findings.has(match.findingIndex) ||
        matched.has(match.labelId)
      )
        throw new Error('Invalid or duplicate adjudication match.');
      const finding = review.findings[match.findingIndex]!;
      const label = c.labels.find((l) => l.id === match.labelId)!;
      if (
        finding.file !== label.file ||
        finding.line !== label.line ||
        !finding.evidence.some(
          (e) =>
            e.repo === label.evidence.repo &&
            e.file === label.evidence.file &&
            e.line === label.evidence.line &&
            e.quote?.includes(label.evidence.quote),
        )
      )
        throw new Error('Adjudicated match lacks labelled anchor or evidence.');
      findings.add(match.findingIndex);
      matched.add(match.labelId);
    }
    const row = {
      id: c.id,
      tp: matched.size,
      fp: review.findings.length - matched.size,
      fn: c.labels.length - matched.size,
    };
    tp += row.tp;
    fp += row.fp;
    fn += row.fn;
    rows.push(row);
  }
  const known = new Set(data.cases.map((c) => c.id));
  if (Object.keys(judgments.cases).some((id) => !known.has(id)))
    throw new Error('Unknown adjudication case.');
  return {
    mode: 'human-adjudicated-saved-reviews',
    datasetVersion: data.version,
    datasetSha256: judgments.datasetSha256,
    run: judgments.run,
    adjudicator: judgments.adjudicator,
    reviewedAt: judgments.reviewedAt,
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    rows,
  };
}
