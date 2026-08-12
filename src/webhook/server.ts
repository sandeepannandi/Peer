import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { verifySignature } from './verify.js';

const logger = createLogger();

export interface PullRequestEvent {
  owner: string;
  repo: string;
  prNumber: number;
}

export type WebhookHandler = (event: PullRequestEvent) => Promise<unknown>;

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
  const pr = payload.pull_request as { number?: number } | undefined;
  const repo = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const number = pr?.number ?? (payload.number as number | undefined);
  const owner = repo?.owner?.login;
  const name = repo?.name;
  if (!number || !owner || !name) return null;
  return { owner, repo: name, prNumber: number };
}

/** HTTP handler: verifies the signature, then dispatches pull_request opened/synchronize events. */
export function createWebhookHandler(env: Env, onReview: WebhookHandler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawBody = await readBody(req);

      const header = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!env.GITHUB_WEBHOOK_SECRET || !verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature)) {
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

      res.writeHead(202).end('accepted');
      Promise.resolve(onReview(event)).catch((err) => logger.error({ err, event }, 'webhook review failed'));
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
export function startWebhookServer(env: Env, onReview: WebhookHandler): void {
  const server = createServer(createWebhookHandler(env, onReview));
  server.on('error', (err) => {
    logger.error({ err }, 'webhook server failed');
    process.exit(1);
  });
  server.listen(env.WEBHOOK_PORT, () => {
    logger.info({ port: env.WEBHOOK_PORT }, 'webhook listening — configure the GitHub App webhook URL to this endpoint');
  });
}
