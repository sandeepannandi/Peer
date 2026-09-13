import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack } from '../../src/context/pack.js';
import { extractProbes } from '../../src/context/probes.js';
import { loadLocalPr, stageLocalRepos } from '../../src/local/fixture.js';
import { runLocalReviewer } from '../../src/local/reviewer.js';
import { indexRepos } from '../../src/mirror/indexer.js';
import { formatReview, buildReviewMarkdown } from '../../src/review/format.js';
import { openDb, type Db } from '../../src/store/db.js';
import { buildNumberedDiff, parseUnifiedDiff } from '../../src/util/diff.js';

const FIXTURES = join(__dirname, '..', 'fixtures');
const OWNER = 'acme';

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-e2e-'));
  db = openDb(join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('local multi-repo pipeline (no GitHub, no Claude)', () => {
  it('stages fixtures, builds a cross-repo context pack, and produces a review citing the other repo', () => {
    const mirror = join(root, 'mirror');

    const staged = stageLocalRepos({
      fixturesRoot: FIXTURES,
      mirrorRoot: mirror,
      owner: OWNER,
      db,
    });
    expect(staged.sort()).toEqual(['repo-a', 'repo-b']);

    const indexed = indexRepos(db, mirror, OWNER);
    expect(indexed.repos).toHaveLength(2);
    expect(indexed.repos.reduce((sum, r) => sum + r.symbols, 0)).toBeGreaterThan(0);

    const pr = loadLocalPr(FIXTURES, 'repo-a', 1);
    expect(pr.title).toBe('Change getUser id type to string');
    expect(pr.diff).toContain('getUser');

    const fileDiffs = parseUnifiedDiff(pr.diff);
    const probes = extractProbes(fileDiffs);
    const pack = buildContextPack({
      db,
      mirrorRoot: mirror,
      owner: OWNER,
      prRepo: 'repo-a',
      numberedDiff: buildNumberedDiff(fileDiffs),
      probes,
      workspaceRoot: join(root, 'workspace'),
    });
    // Cross-repo awareness: the context pack must include repo-b (the consumer).
    expect(pack.contextFiles).toBeGreaterThan(0);

    const review = runLocalReviewer(pack.dir, fileDiffs, `${OWNER}/repo-a#1`);
    expect(review.overall).toBe('changes_requested');
    expect(review.findings.length).toBeGreaterThan(0);
    expect(review.findings[0]!.file).toBe('src/api.ts');
    expect(review.findings[0]!.evidence[0]!.repo).toBe('acme/repo-b');
    expect(review.findings[0]!.evidence[0]!.file).toBe('src/client.ts');

    // Formatting layer still works: the finding maps to an inline comment on line 1.
    const formatted = formatReview(review, fileDiffs, 20);
    expect(formatted.comments).toHaveLength(review.findings.length);
    expect(formatted.comments[0]).toMatchObject({ path: 'src/api.ts', line: 1, side: 'RIGHT' });

    // The artifacts the CLI writes (saveLocalReview): review.json + review.md.
    const mdText = buildReviewMarkdown(review, fileDiffs, 20);
    expect(mdText).toContain('acme/repo-b/src/client.ts');
  });

  it('throws a helpful error for a missing PR fixture', () => {
    expect(() => loadLocalPr(FIXTURES, 'repo-a', 999)).toThrow(/prs\/999\.diff/);
  });
});
