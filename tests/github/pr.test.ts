import { describe, expect, it } from 'vitest';
import type { InstallationOctokit } from '../../src/github/auth.js';
import { fetchPr } from '../../src/github/pr.js';

const RAW_DIFF = [
  'diff --git a/src/api.ts b/src/api.ts',
  '--- a/src/api.ts',
  '+++ b/src/api.ts',
  '@@ -1,1 +1,2 @@',
  ' export function listUsers() {',
  '+  return http.get("/api/v2/users");',
  '+}',
].join('\n');

function stubOctokit(commits: Array<{ sha: string }> = [{ sha: 'abc123' }, { sha: 'def456' }]) {
  return {
    request: async (_route: string, opts: { headers?: { accept?: string } } = {}) => {
      if (opts.headers?.accept?.includes('diff')) {
        return { data: RAW_DIFF };
      }
      return {
        data: {
          title: 'Add endpoint',
          body: 'some body',
          base: { ref: 'main', sha: 'base' },
          head: { sha: commits.at(-1)?.sha },
        },
      };
    },
    paginate: async (route: string) => {
      if (route.includes('/files')) {
        return [
          {
            filename: 'src/api.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            patch: '+  return http.get("/api/v2/users");\n+}',
          },
        ];
      }
      if (route.includes('/commits')) return commits;
      throw new Error(`unexpected route: ${route}`);
    },
  } as unknown as InstallationOctokit;
}

describe('fetchPr', () => {
  it('assembles PR facts, head sha, raw diff and changed files', async () => {
    const pr = await fetchPr(stubOctokit(), 'acme', 'api', 42);

    expect(pr.title).toBe('Add endpoint');
    expect(pr.body).toBe('some body');
    expect(pr.baseRef).toBe('main');
    expect(pr.headSha).toBe('def456');
    expect(pr.diff).toBe(RAW_DIFF);
    expect(pr.files).toEqual([
      {
        path: 'src/api.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '+  return http.get("/api/v2/users");\n+}',
      },
    ]);
  });

  it('rejects PR heads that change during snapshot acquisition', async () => {
    const client = stubOctokit();
    const original = client.request;
    let reads = 0;
    client.request = (async (route: string, opts: { headers?: { accept?: string } } = {}) => {
      const res = await original(route as never, opts as never);
      if (!opts.headers) {
        reads++;
        if (reads === 3) res.data.head.sha = 'changed';
      }
      return res;
    }) as InstallationOctokit['request'];
    await expect(fetchPr(client, 'acme', 'api', 42)).rejects.toThrow('snapshot changed');
  });

  it('throws when the PR has no commits', async () => {
    await expect(fetchPr(stubOctokit([]), 'acme', 'api', 42)).rejects.toThrow(/no commits/);
  });
});
