import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../github/app.js';
import { openDb } from '../store/db.js';
import type { Env } from '../config/env.js';

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

async function defaultRun(command: string, args: string[] = []): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  try {
    const { stdout, stderr } = await execa(command, args);
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
    detail: claudeVersion.ok ? `claude ${claudeVersion.stdout?.trim()}` : 'Claude Code CLI not reachable — run npm install -g @anthropic-ai/claude-code',
  });

  const doctor = await run(claude, ['doctor']);
  const signedIn = !/not signed in/i.test(doctor.stdout ?? '');
  const authDetail = !claudeVersion.ok
    ? 'Claude Code CLI not reachable — run npm install -g @anthropic-ai/claude-code'
    : signedIn
      ? 'Claude subscription session found'
      : 'Not signed in — run `claude login` with your subscription account';
  results.push({
    name: 'claude auth',
    ok: claudeVersion.ok && signedIn,
    detail: authDetail,
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
