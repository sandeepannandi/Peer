import { describe, expect, it } from 'vitest';
import { PeerOctokit } from '../../src/github/app.js';

// Real Octokit middleware with fake fetch, no GitHub traffic.
describe('GitHub transport retries', () => {
  it.each([429, 500, 503])('does not repeat review POST after HTTP %s', async (status) => {
    const client = new PeerOctokit({ auth: 'test-only' });
    let calls = 0;
    await expect(
      client.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner: 'test',
        repo: 'test',
        pull_number: 1,
        body: 'test',
        event: 'COMMENT',
        headers: { authorization: 'Bearer test-only' },
        request: {
          retries: 0,
          fetch: async () => {
            calls++;
            return new Response(JSON.stringify({ message: 'test failure' }), {
              status,
              headers: { 'content-type': 'application/json', 'retry-after': '0' },
            });
          },
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
