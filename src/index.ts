#!/usr/bin/env node
import 'dotenv/config';

import { join } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { loadEnv, type Env } from './config/env.js';
import { createApp } from './github/app.js';
import { createInstallationOctokit } from './github/auth.js';
import { fetchPr } from './github/pr.js';
import { loadLocalPr, stageLocalRepos } from './local/fixture.js';
import { runLocalReviewer } from './local/reviewer.js';
import { indexRepos } from './mirror/indexer.js';
import { mirrorOrgRepos } from './mirror/mirror.js';
import { buildPack, reviewPullRequest, saveLocalReview } from './review/pipeline.js';
import { openDb } from './store/db.js';
import { runDoctor } from './util/doctor.js';
import { createLogger } from './util/logger.js';
import { startWebhookServer } from './webhook/server.js';

const logger = createLogger();

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function dbPath(env: Env): string {
  return join(env.DATA_DIR, 'index.db');
}

function mirrorRoot(env: Env): string {
  return join(env.DATA_DIR, 'mirror');
}

const program = new Command();

program
  .name('peer')
  .description(
    'Cross-repo GitHub code-review bot — reviews pull requests with context from other repos in the org, powered by Claude Code',
  )
  .version('0.1.0');

interface ReviewOptions {
  owner: string;
  repo: string;
  pr: number;
  post?: boolean;
  local?: boolean;
  fixtures?: string;
}

program
  .command('review')
  .description('Review a pull request with cross-repo context')
  .requiredOption('--owner <owner>', 'GitHub organisation / owner')
  .requiredOption('--repo <repo>', 'Repository name')
  .requiredOption('--pr <number>', 'Pull request number', parsePositiveInt)
  .option('--post', 'Post the review to GitHub as a PR review (default: save locally)')
  .option(
    '--local',
    'Run retrieval and context packing against bundled fixtures, then deterministic stub review (no GitHub, no Claude)',
  )
  .option('--fixtures <dir>', 'Fixtures directory for --local mode', 'tests/fixtures')
  .action(async (opts: ReviewOptions) => {
    const env = loadEnv();

    if (opts.local) {
      if (opts.post) {
        throw new Error('--post cannot be used with --local (fixture mode has no GitHub).');
      }
      const db = openDb(dbPath(env));
      stageLocalRepos({
        fixturesRoot: opts.fixtures!,
        mirrorRoot: mirrorRoot(env),
        owner: opts.owner,
        db,
      });
      indexRepos(db, mirrorRoot(env), opts.owner);
      const pr = loadLocalPr(opts.fixtures!, opts.repo, opts.pr);
      const { fileDiffs, pack } = buildPack(
        env,
        db,
        opts.owner,
        opts.repo,
        pr.diff,
        join(env.DATA_DIR, 'workspace'),
      );
      logger.info({ dir: pack.dir, contextFiles: pack.contextFiles }, 'local context pack built');
      const review = runLocalReviewer(pack.dir, fileDiffs, `${opts.owner}/${opts.repo}#${opts.pr}`);
      saveLocalReview(pack.dir, review, fileDiffs, env.MAX_REVIEW_COMMENTS);
      db.close();
      return;
    }

    await reviewPullRequest(
      env,
      { owner: opts.owner, repo: opts.repo, prNumber: opts.pr },
      opts.post ?? false,
    );
  });

program
  .command('webhook')
  .description('Start the webhook listener: auto-review PRs on opened/synchronize')
  .option('--port <port>', 'Override WEBHOOK_PORT', parsePositiveInt)
  .action(async (opts: { port?: number }) => {
    const env = loadEnv();
    if (!env.GITHUB_WEBHOOK_SECRET) {
      throw new Error('GITHUB_WEBHOOK_SECRET is required for webhook mode — set it in .env');
    }
    const port = opts.port ?? env.WEBHOOK_PORT;
    startWebhookServer({ ...env, WEBHOOK_PORT: port }, (event) =>
      reviewPullRequest(
        env,
        { owner: event.owner, repo: event.repo, prNumber: event.prNumber },
        true,
      ),
    );
  });

program
  .command('mirror')
  .description('Clone or refresh the org repositories into the local mirror')
  .requiredOption('--owner <owner>', 'GitHub organisation / owner')
  .action(async (opts: { owner: string }) => {
    const env = loadEnv();
    const app = createApp(env);
    const { octokit, token } = await createInstallationOctokit(app, opts.owner);
    const db = openDb(dbPath(env));
    const { mirrored, skipped, failed } = await mirrorOrgRepos({
      octokit,
      token,
      owner: opts.owner,
      mirrorRoot: mirrorRoot(env),
      db,
    });
    db.close();
    logger.info(
      { owner: opts.owner, mirrored: mirrored.length, skipped, failed },
      'mirror complete',
    );
  });

program
  .command('index')
  .description('Build/refresh the SQLite symbol index from the mirror')
  .requiredOption('--owner <owner>', 'GitHub organisation / owner')
  .action(async (opts: { owner: string }) => {
    const env = loadEnv();
    const db = openDb(dbPath(env));
    const { repos, skipped } = indexRepos(db, mirrorRoot(env), opts.owner);
    db.close();
    logger.info({ owner: opts.owner, repos, skipped }, 'index complete');
  });

program
  .command('context')
  .description(
    'Fetch a PR and build its cross-repo context pack (inspect what the reviewer will see)',
  )
  .requiredOption('--owner <owner>', 'GitHub organisation / owner')
  .requiredOption('--repo <repo>', 'Repository name')
  .requiredOption('--pr <number>', 'Pull request number', parsePositiveInt)
  .action(async (opts: { owner: string; repo: string; pr: number }) => {
    const env = loadEnv();
    const app = createApp(env);
    const { octokit } = await createInstallationOctokit(app, opts.owner);
    const pr = await fetchPr(octokit, opts.owner, opts.repo, opts.pr);
    const db = openDb(dbPath(env));
    const { pack } = buildPack(
      env,
      db,
      opts.owner,
      opts.repo,
      pr.diff,
      join(env.DATA_DIR, 'workspace'),
    );
    db.close();
    logger.info(
      {
        owner: opts.owner,
        repo: opts.repo,
        pr: opts.pr,
        dir: pack.dir,
        contextFiles: pack.contextFiles,
        skippedForBudget: pack.skippedForBudget,
      },
      'context pack built',
    );
  });

program
  .command('doctor')
  .description('Check the environment: Claude Code, git, GitHub App credentials, SQLite')
  .action(async () => {
    const env = loadEnv();
    const results = await runDoctor(env);
    let failed = false;
    for (const result of results) {
      logger.info(
        { check: result.name, ok: result.ok, detail: result.detail },
        result.ok ? 'check passed' : 'check FAILED',
      );
      if (!result.ok) failed = true;
    }
    if (failed) process.exit(1);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  logger.error({ err }, 'fatal: peer failed');
  process.exit(1);
}
