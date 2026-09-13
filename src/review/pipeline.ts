import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewPrompt, buildReviewSystemPrompt } from '../claude/prompt.js';
import { runClaudeReviewWithRetry } from '../claude/runner.js';
import type { Env } from '../config/env.js';
import { buildContextPack, type PackResult } from '../context/pack.js';
import { extractProbes } from '../context/probes.js';
import { createApp } from '../github/app.js';
import { createInstallationOctokit } from '../github/auth.js';
import { fetchPr } from '../github/pr.js';
import { indexRepos } from '../mirror/indexer.js';
import { mirrorOrgRepos } from '../mirror/mirror.js';
import { openDb, type Db } from '../store/db.js';
import { buildNumberedDiff, parseUnifiedDiff, type FileDiff } from '../util/diff.js';
import { createLogger } from '../util/logger.js';
import { buildReviewMarkdown, formatReview } from './format.js';
import { postReview } from './post.js';
import type { Review } from './schema.js';

const logger = createLogger();

export interface ReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ReviewOutcome {
  review: Review;
  dir: string;
  /** true = posted, false = already posted (deduped), null = saved locally. */
  posted: boolean | null;
}

export function buildPack(
  env: Env,
  db: Db,
  owner: string,
  repo: string,
  diff: string,
  workspaceRoot: string,
): { fileDiffs: FileDiff[]; pack: PackResult } {
  const fileDiffs = parseUnifiedDiff(diff);
  const probes = extractProbes(fileDiffs);
  const pack = buildContextPack({
    db,
    mirrorRoot: join(env.DATA_DIR, 'mirror'),
    owner,
    prRepo: repo,
    numberedDiff: buildNumberedDiff(fileDiffs),
    probes,
    maxFiles: env.REVIEW_MAX_CONTEXT_FILES,
    budgetChars: env.CONTEXT_TOKEN_BUDGET,
    workspaceRoot,
  });
  return { fileDiffs, pack };
}

export function saveLocalReview(
  dir: string,
  review: Review,
  fileDiffs: FileDiff[],
  maxComments: number,
): void {
  writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2));
  writeFileSync(join(dir, 'review.md'), buildReviewMarkdown(review, fileDiffs, maxComments));
  console.log(JSON.stringify(review, null, 2));
  logger.info(
    { dir, findings: review.findings.length, overall: review.overall },
    'review saved locally',
  );
}

/** Full review flow: fetch PR → mirror+index → context pack → Claude → post or save. */
export async function reviewPullRequest(
  env: Env,
  req: ReviewRequest,
  post: boolean,
): Promise<ReviewOutcome> {
  const { owner, repo, prNumber } = req;
  const db = openDb(join(env.DATA_DIR, 'index.db'));
  const workspaceRoot = join(env.DATA_DIR, 'workspace');

  try {
    const app = createApp(env);
    const { octokit, token } = await createInstallationOctokit(app, owner);
    const pr = await fetchPr(octokit, owner, repo, prNumber);

    const mirror = join(env.DATA_DIR, 'mirror');
    const mirrored = await mirrorOrgRepos({ octokit, token, owner, mirrorRoot: mirror, db });
    const indexed = indexRepos(db, mirror, owner);
    logger.info(
      {
        owner,
        mirrored: mirrored.mirrored.length,
        skipped: mirrored.skipped,
        failed: mirrored.failed,
        indexed: indexed.repos.length,
      },
      'mirror + index ensured',
    );

    const { fileDiffs, pack } = buildPack(env, db, owner, repo, pr.diff, workspaceRoot);
    logger.info(
      { dir: pack.dir, contextFiles: pack.contextFiles, skippedForBudget: pack.skippedForBudget },
      'context pack built',
    );

    const systemPrompt = buildReviewSystemPrompt();
    const prompt = buildReviewPrompt({
      owner,
      repo,
      prNumber,
      title: pr.title,
      baseRef: pr.baseRef,
      contextFiles: pack.contextFiles,
    });
    writeFileSync(join(pack.dir, 'prompt.txt'), prompt);

    const review = await runClaudeReviewWithRetry({
      env,
      workspaceDir: pack.dir,
      systemPrompt,
      prompt,
    });

    if (post) {
      const formatted = formatReview(review, fileDiffs, env.MAX_REVIEW_COMMENTS);
      const result = await postReview(octokit, db, {
        owner,
        repo,
        prNumber,
        headSha: pr.headSha,
        event: formatted.event,
        body: formatted.body,
        comments: formatted.comments,
      });
      writeFileSync(join(pack.dir, 'review.json'), JSON.stringify(review, null, 2));
      console.log(JSON.stringify(review, null, 2));
      logger.info(
        {
          reviewId: result.reviewId,
          inlineComments: formatted.comments.length,
          droppedToBody: formatted.dropped.length,
        },
        result.posted
          ? 'review posted to GitHub'
          : 'review already posted for this head commit — skipped',
      );
      return { review, dir: pack.dir, posted: result.posted };
    }

    saveLocalReview(pack.dir, review, fileDiffs, env.MAX_REVIEW_COMMENTS);
    return { review, dir: pack.dir, posted: null };
  } finally {
    db.close();
  }
}
