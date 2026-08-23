import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { loadEnv } from '../../src/config/env.js';
import { runClaudeReview, type QueryFn } from '../../src/claude/runner.js';

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
    yield { type: 'result', subtype: 'success', result: '{"summary":"ok","overall":"approve","findings":[]}' } as SDKMessage;
  };
}

const opts = () => ({ env, workspaceDir, systemPrompt: 'system', prompt: 'prompt' });

describe('security: agent permission configuration', () => {
  it('Bash is explicitly in disallowedTools to block arbitrary shell execution', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.disallowedTools).toContain('Bash');
  });

  it('Bash is NOT in allowedTools (which would grant shell access under bypassPermissions)', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    const allowed = options?.allowedTools ?? [];
    expect(allowed.some((t) => t.startsWith('Bash'))).toBe(false);
  });

  it('only Read, Grep, Glob are in allowedTools (read-only inspection)', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('permissionMode is bypassPermissions (needed for headless operation, but Bash is blocked by disallowedTools)', async () => {
    const calls = { options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(calls));

    const options = calls.options[0];
    expect(options?.permissionMode).toBe('bypassPermissions');
    // The security invariant: bypassPermissions + disallowedTools: ['Bash']
    // means the agent can auto-approve Read/Grep/Glob but cannot use Bash.
    expect(options?.disallowedTools).toEqual(['Bash']);
  });
});
