import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Env } from '../config/env.js';
import { openDb } from '../store/db.js';
import { enqueueReview, type ReviewJobInput } from '../store/jobs.js';
import { createLogger } from '../util/logger.js';
import { verifySignature } from './verify.js';
import { startJobWorker, type JobHandler } from './worker.js';

const logger = createLogger();

export interface PullRequestEvent {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

export type WebhookHandler = (event: ReviewJobInput) => void | Promise<void>;

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Extract owner/repo/PR from a pull_request webhook payload. */
export function parsePullRequestPayload(payload: Record<string, unknown>): PullRequestEvent | null {
  const pr = payload.pull_request as { number?: number; head?: { sha?: string } } | undefined;
  const repo = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const number = pr?.number ?? (payload.number as number | undefined);
  const owner = repo?.owner?.login;
  const name = repo?.name;
  const headSha = pr?.head?.sha;
  if (
    !Number.isSafeInteger(number) ||
    Number(number) <= 0 ||
    typeof owner !== 'string' ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    typeof name !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    name === '.' ||
    name === '..' ||
    typeof headSha !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(headSha)
  )
    return null;
  return { owner, repo: name, prNumber: Number(number), headSha };
}

/** HTTP handler: verifies the signature, then dispatches pull_request opened/synchronize events. */
export function createWebhookHandler(env: Env, onReview: WebhookHandler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawBody = await readBody(req);

      const header = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(header) ? header[0] : header;
      if (
        !env.GITHUB_WEBHOOK_SECRET ||
        !verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature)
      ) {
        res.writeHead(401).end('invalid signature');
        return;
      }

      if (req.headers['x-github-event'] !== 'pull_request') {
        res.writeHead(204).end();
        return;
      }

      const payload = JSON.parse(rawBody) as { action?: string } & Record<string, unknown>;
      const event = parsePullRequestPayload(payload);
      if (!event || (payload.action !== 'opened' && payload.action !== 'synchronize')) {
        res.writeHead(204).end();
        return;
      }

      const deliveryId = req.headers['x-github-delivery'];
      if (typeof deliveryId !== 'string' || !deliveryId || deliveryId.length > 200) {
        res.writeHead(400).end('missing delivery id');
        return;
      }
      try {
        await onReview({ ...event, deliveryId });
      } catch (err) {
        logger.error({ err }, 'durable enqueue failed');
        res.writeHead(503).end('queue unavailable');
        return;
      }
      res.writeHead(202).end('accepted');
    } catch (err) {
      logger.error({ err }, 'webhook request failed');
      if (!res.headersSent) {
        try {
          res.writeHead(400).end('bad request');
        } catch {
          // response already sent — nothing to do
        }
      }
    }
  };
}

/** Start the webhook listener (blocks; callers run it as a long-lived process). */
export function startWebhookServer(env: Env, onReview: JobHandler): void {
  const db = openDb(join(env.DATA_DIR, 'index.db'));
  const server = createServer(createWebhookHandler(env, (event) => enqueueReview(db, event)));
  const worker = startJobWorker(db, onReview);
  server.on('error', (err) => {
    logger.error({ err }, 'webhook server failed');
    process.exit(1);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void worker.stop().then(() => db.close());
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(env.WEBHOOK_PORT, () => {
    logger.info({ port: env.WEBHOOK_PORT }, 'webhook listening with durable review queue');
  });
}
