import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import {
  createWebhookHandler,
  parsePullRequestPayload,
  type PullRequestEvent,
} from '../../src/webhook/server.js';

let root: string;
let env: ReturnType<typeof loadEnv>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-webhook-'));
  env = loadEnv({ GITHUB_WEBHOOK_SECRET: 'secret', DATA_DIR: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PR_PAYLOAD = JSON.stringify({
  action: 'opened',
  number: 7,
  pull_request: { number: 7 },
  repository: { name: 'api', owner: { login: 'acme' } },
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
}

describe('parsePullRequestPayload', () => {
  it('extracts owner, repo and PR number', () => {
    const event = parsePullRequestPayload(JSON.parse(PR_PAYLOAD) as Record<string, unknown>);
    expect(event).toEqual({ owner: 'acme', repo: 'api', prNumber: 7 });
  });

  it('returns null for a malformed payload', () => {
    expect(parsePullRequestPayload({})).toBeNull();
  });
});

describe('createWebhookHandler', () => {
  async function runHandler(
    handler: ReturnType<typeof createWebhookHandler>,
    body: string,
    headers: Record<string, string>,
  ): Promise<number> {
    // The handler reads req via node's http.IncomingMessage API.
    const req = {
      headers,
      on: (event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(body));
        if (event === 'end') cb();
        return req;
      },
      destroy: () => {},
    } as unknown as import('node:http').IncomingMessage;

    let status = 0;
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: () => {},
    } as unknown as import('node:http').ServerResponse;

    await handler(req, res);
    return status;
  }

  it('dispatches a valid pull_request opened event to the review callback', async () => {
    const calls: PullRequestEvent[] = [];
    const handler = createWebhookHandler(
      env,
      vi.fn(async (e: PullRequestEvent) => void calls.push(e)),
    );
    const status = await runHandler(handler, PR_PAYLOAD, {
      'x-hub-signature-256': sign(PR_PAYLOAD),
      'x-github-event': 'pull_request',
    });
    expect(status).toBe(202);
    expect(calls).toEqual([{ owner: 'acme', repo: 'api', prNumber: 7 }]);
  });

  it('rejects a request with an invalid signature', async () => {
    const calls: PullRequestEvent[] = [];
    const handler = createWebhookHandler(
      env,
      vi.fn(async (e: PullRequestEvent) => void calls.push(e)),
    );
    const status = await runHandler(handler, PR_PAYLOAD, {
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-github-event': 'pull_request',
    });
    expect(status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('ignores non-pull_request events (ping, push, etc.)', async () => {
    const calls: PullRequestEvent[] = [];
    const handler = createWebhookHandler(
      env,
      vi.fn(async (e: PullRequestEvent) => void calls.push(e)),
    );
    const status = await runHandler(handler, JSON.stringify({ zen: 'hello' }), {
      'x-hub-signature-256': sign(JSON.stringify({ zen: 'hello' })),
      'x-github-event': 'ping',
    });
    expect(status).toBe(204);
    expect(calls).toEqual([]);
  });

  it('rejects a request body over 1MB', async () => {
    const calls: PullRequestEvent[] = [];
    const handler = createWebhookHandler(
      env,
      vi.fn(async (e: PullRequestEvent) => void calls.push(e)),
    );
    const huge = `x`.repeat(1024 * 1024 + 1);
    const status = await runHandler(handler, huge, {
      'x-hub-signature-256': sign(huge),
      'x-github-event': 'pull_request',
    });
    expect(status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('ignores pull_request actions other than opened/synchronize', async () => {
    const calls: PullRequestEvent[] = [];
    const handler = createWebhookHandler(
      env,
      vi.fn(async (e: PullRequestEvent) => void calls.push(e)),
    );
    const closed = JSON.parse(PR_PAYLOAD) as Record<string, unknown>;
    closed.action = 'closed';
    const body = JSON.stringify(closed);
    const status = await runHandler(handler, body, {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
    });
    expect(status).toBe(204);
    expect(calls).toEqual([]);
  });
});
