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
  overrides: Partial<Record<string, { ok?: boolean; stdout?: string }>> = {},
): RunFn {
  return async (command: string, args: string[] = []) => {
    const key = args.includes('doctor')
      ? 'doctor'
      : command.includes('claude')
        ? 'claude'
        : command;
    const override = overrides[key];
    if (override) {
      return { ok: override.ok ?? true, stdout: override.stdout };
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
        doctor: { stdout: 'Everything OK' },
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
        doctor: { ok: false, stdout: 'Not signed in to claude.ai' },
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
        doctor: { ok: false, stdout: 'Not signed in to claude.ai' },
      }),
    );

    const auth = results.find((r) => r.name === 'claude auth')!;
    expect(auth.ok).toBe(false);
    expect(auth.detail).toContain('claude login');
  });

  it('fails the github app check when credentials are missing or invalid', async () => {
    const results = await runDoctor(env, stubRun());
    const github = results.find((r) => r.name === 'github app');
    expect(github?.ok).toBe(false);
  });
});
