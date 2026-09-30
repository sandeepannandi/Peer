import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Env } from '../config/env.js';
import { createApp } from '../github/app.js';
import { openDb } from '../store/db.js';

export interface DoctorResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunFn {
  (command: string, args?: string[]): Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
}

/** Resolve the Claude Code CLI: the SDK's bundled binary, else `claude` on PATH. */
export function findClaudeBinary(): string {
  const bundled = join(
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  return existsSync(bundled) ? bundled : 'claude';
}

async function defaultRun(
  command: string,
  args: string[] = [],
): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  try {
    const { stdout, stderr } = await execa(command, args, { timeout: 15000 });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const detail = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: detail.stdout, stderr: detail.stderr ?? detail.message };
  }
}

export async function runDoctor(env: Env, run: RunFn = defaultRun): Promise<DoctorResult[]> {
  const claude = findClaudeBinary();
  const results: DoctorResult[] = [];

  const git = await run('git', ['--version']);
  results.push({ name: 'git', ok: git.ok, detail: git.stdout?.trim() ?? 'git not found' });

  const claudeVersion = await run(claude, ['--version']);
  results.push({
    name: 'claude',
    ok: claudeVersion.ok,
    detail: claudeVersion.ok
      ? `claude ${claudeVersion.stdout?.trim()}`
      : 'Claude Code CLI not reachable — run npm install -g @anthropic-ai/claude-code',
  });

  // doctor is installation diagnostics, not proof of an authenticated session.
  // Do not expose raw auth output: it can include account identifiers.
  const auth = claudeVersion.ok ? await run(claude, ['auth', 'status', '--json']) : null;
  let signedIn = false;
  if (auth?.ok) {
    try {
      const status: unknown = JSON.parse(auth.stdout ?? '');
      if (status && typeof status === 'object') {
        const fields = status as Record<string, unknown>;
        signedIn =
          fields.loggedIn === true &&
          fields.authMethod === 'claude.ai' &&
          fields.apiProvider === 'firstParty' &&
          !fields.apiKeySource;
      }
    } catch {
      /* Unknown output fails closed, even with a zero exit status. */
    }
  }
  results.push({
    name: 'claude auth',
    ok: signedIn,
    detail: !claudeVersion.ok
      ? 'Claude Code CLI not reachable - install or update Claude Code'
      : signedIn
        ? 'Claude subscription login reported by auth status (no model request tested)'
        : 'Subscription login not verified - run `claude auth login`, then `claude auth status --json`; update older CLIs if unsupported',
  });

  try {
    createApp(env);
    results.push({ name: 'github app', ok: true, detail: 'App ID + private key valid' });
  } catch (err) {
    results.push({
      name: 'github app',
      ok: false,
      detail: err instanceof Error ? err.message : 'invalid GitHub App credentials',
    });
  }

  try {
    const db = openDb(join(env.DATA_DIR, 'index.db'));
    db.close();
    results.push({ name: 'sqlite', ok: true, detail: `${env.DATA_DIR} is writable` });
  } catch (err) {
    results.push({
      name: 'sqlite',
      ok: false,
      detail: err instanceof Error ? err.message : 'SQLite not writable',
    });
  }

  return results;
}
