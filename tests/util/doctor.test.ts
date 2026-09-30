import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { runDoctor, type RunFn } from '../../src/util/doctor.js';

let root: string;
let env: ReturnType<typeof loadEnv>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-doctor-'));
  env = loadEnv({ DATA_DIR: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stubRun(
  overrides: Partial<Record<string, { ok?: boolean; stdout?: string; stderr?: string }>> = {},
): RunFn {
  return async (command: string, args: string[] = []) => {
    const key = args.includes('status') ? 'auth' : command.includes('claude') ? 'claude' : command;
    const override = overrides[key];
    if (override) {
      return { ok: override.ok ?? true, stdout: override.stdout, stderr: override.stderr };
    }
    return { ok: true, stdout: `${command} works` };
  };
}

describe('runDoctor', () => {
  it('reports green when git, claude and auth are all available', async () => {
    const results = await runDoctor(
      env,
      stubRun({
        claude: { ok: true, stdout: 'claude 2.1.227' },
        auth: {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
          }),
        },
      }),
    );

    const byName = Object.fromEntries(results.map((r) => [r.name, r.ok]));
    expect(byName.git).toBe(true);
    expect(byName.claude).toBe(true);
    expect(byName['claude auth']).toBe(true);
    expect(byName.sqlite).toBe(true);
  });

  it('flags a missing claude binary and a missing subscription login', async () => {
    const results = await runDoctor(
      env,
      stubRun({
        claude: { ok: false, stdout: '' },
        auth: { ok: false, stdout: 'Not signed in to claude.ai' },
      }),
    );

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.claude.ok).toBe(false);
    // When the binary is missing, the auth detail must say so — not "session found".
    expect(byName['claude auth'].detail).toContain('not reachable');
    expect(byName['claude auth'].ok).toBe(false);
  });

  it('reports a missing login when claude exists but is not signed in', async () => {
    const results = await runDoctor(
      env,
      stubRun({
        claude: { ok: true, stdout: 'claude 2.1.227' },
        auth: { ok: false, stdout: 'Not signed in to claude.ai' },
      }),
    );

    const auth = results.find((r) => r.name === 'claude auth')!;
    expect(auth.ok).toBe(false);
    expect(auth.detail).toContain('claude auth login');
  });

  it.each([
    { ok: false, stderr: 'expired session; private@example.com' },
    {
      ok: false,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    },
    { ok: true, stdout: '' },
    { ok: true, stdout: 'Everything OK' },
    { ok: true, stdout: '{bad json' },
    { ok: true, stdout: 'null' },
    {
      ok: true,
      stdout: JSON.stringify({
        loggedIn: false,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    },
    {
      ok: true,
      stdout: JSON.stringify({
        loggedIn: 'true',
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    },
    {
      ok: true,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
    },
    {
      ok: true,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }),
    },
    {
      ok: true,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        apiKeySource: 'private@example.com',
      }),
    },
  ])('does not infer subscription auth from failures or ambiguous output: %j', async (auth) => {
    const results = await runDoctor(env, stubRun({ auth }));
    const result = results.find((r) => r.name === 'claude auth')!;
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain('private@example.com');
  });

  it('uses auth status JSON, never diagnostic text, and skips auth when binary is absent', async () => {
    const calls: string[][] = [];
    const run: RunFn = async (_command, args = []) => {
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
      };
    };
    await runDoctor(env, run);
    expect(calls).toContainEqual(['auth', 'status', '--json']);
    expect(calls).not.toContainEqual(['doctor']);
    calls.length = 0;
    await runDoctor(env, async (_command, args = []) => {
      calls.push(args);
      return { ok: false };
    });
    expect(calls).not.toContainEqual(['auth', 'status', '--json']);
  });

  it('fails the github app check when credentials are missing or invalid', async () => {
    const results = await runDoctor(env, stubRun());
    const github = results.find((r) => r.name === 'github app');
    expect(github?.ok).toBe(false);
  });
});
