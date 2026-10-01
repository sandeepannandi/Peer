import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeReview, type QueryFn } from '../../src/claude/runner.js';
import { loadEnv } from '../../src/config/env.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'peer-security-'));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

const env = loadEnv({});

function fakeQuery(calls: { options: (Options | undefined)[] }): QueryFn {
  return async function* (params: { prompt: string; options?: Options }) {
    calls.options.push(params.options);
    yield {
      type: 'result',
      subtype: 'success',
      result: '{"summary":"ok","overall":"approve","findings":[]}',
    } as SDKMessage;
  };
}

const opts = () => ({ env, workspaceDir, systemPrompt: 'system', prompt: 'prompt' });

describe('security: agent permission configuration', () => {
  it('Bash is absent from the actual tool list', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.tools).not.toContain('Bash');
  });

  it('Bash is not pre-approved', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    const allowed = options?.allowedTools ?? [];
    expect(allowed.some((t) => t.startsWith('Bash'))).toBe(false);
  });

  it('only inspection tools are pre-approved', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.allowedTools).toBeUndefined();
  });

  it('permission bypass is disabled and every tool call is guarded', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.permissionMode).toBe('default');
    expect(options?.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
  });
});
