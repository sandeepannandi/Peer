import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runClaudeReview,
  runClaudeReviewWithRetry,
  type QueryFn,
} from '../../src/claude/runner.js';
import { loadEnv } from '../../src/config/env.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'peer-claude-'));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

const env = loadEnv({});

const VALID_REVIEW = {
  summary: 'ok',
  overall: 'approve',
  findings: [],
};

function fakeQuery(
  results: string[],
  calls: { prompts: string[]; options: (Options | undefined)[] },
): QueryFn {
  return async function* (params: { prompt: string; options?: Options }) {
    calls.prompts.push(params.prompt);
    calls.options.push(params.options);
    for (const result of results) {
      yield { type: 'result', subtype: 'success', result } as SDKMessage;
    }
  };
}

// Built per-test: workspaceDir is only assigned in beforeEach.
const opts = () => ({ env, workspaceDir, systemPrompt: 'system', prompt: 'prompt' });

describe('runClaudeReview', () => {
  it('returns the final assistant text', async () => {
    const calls = { prompts: [] as string[], options: [] as (Options | undefined)[] };
    const text = await runClaudeReview(opts(), fakeQuery(['{"summary":"ok"}'], calls));

    expect(text).toBe('{"summary":"ok"}');
    expect(calls.prompts).toEqual(['prompt']);
  });

  it('wires the SDK options: model, cwd, read-only tools, isolated permissions, maxTurns', async () => {
    const calls = { prompts: [] as string[], options: [] as (Options | undefined)[] };
    await runClaudeReview(opts(), fakeQuery(['{}'], calls));

    const options = calls.options[0];
    expect(options?.systemPrompt).toBe('system');
    expect(options?.model).toBe('sonnet');
    expect(options?.cwd).toBe(workspaceDir);
    expect(options?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options?.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options?.permissionMode).toBe('default');
    expect(options?.canUseTool).toBeTypeOf('function');
    expect(options?.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.mcpServers).toEqual({});
    expect(options?.plugins).toEqual([]);
    expect(options?.skills).toEqual([]);
    expect(options?.maxTurns).toBe(30);
  });

  it('throws when no result event arrives', async () => {
    const queryFn: QueryFn = async function* () {
      // no result event
    };
    await expect(runClaudeReview(opts(), queryFn)).rejects.toThrow(/no final result/);
  });

  it('throws a clear error on an error result event', async () => {
    const queryFn: QueryFn = async function* () {
      yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'] } as SDKMessage;
    };
    await expect(runClaudeReview(opts(), queryFn)).rejects.toThrow(
      /Claude Code review failed: boom/,
    );
  });
});

describe('runClaudeReviewWithRetry', () => {
  it('returns the parsed review without a retry when valid', async () => {
    const calls = { prompts: [] as string[], options: [] as (Options | undefined)[] };
    const review = await runClaudeReviewWithRetry(
      opts(),
      fakeQuery([JSON.stringify(VALID_REVIEW)], calls),
    );

    expect(review.overall).toBe('approve');
    expect(calls.prompts).toHaveLength(1);
  });

  it('retries once with a repair prompt when the first response is invalid', async () => {
    const calls = { prompts: [] as string[], options: [] as (Options | undefined)[] };
    const queryFn: QueryFn = async function* (params: { prompt: string; options?: Options }) {
      calls.prompts.push(params.prompt);
      calls.options.push(params.options);
      const text = calls.prompts.length === 1 ? 'not json at all' : JSON.stringify(VALID_REVIEW);
      yield { type: 'result', subtype: 'success', result: text } as SDKMessage;
    };

    const review = await runClaudeReviewWithRetry(opts(), queryFn);

    expect(review.overall).toBe('approve');
    expect(calls.prompts).toHaveLength(2);
    expect(calls.prompts[1]).toContain('could not be parsed');
    for (const options of calls.options) {
      expect(options?.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(options?.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
      expect(options?.permissionMode).toBe('default');
    }
  });

  it('applies citation validation to both attempts and never returns invalid citations', async () => {
    const calls = { prompts: [] as string[], options: [] as (Options | undefined)[] };
    let validations = 0;
    await expect(
      runClaudeReviewWithRetry(
        {
          ...opts(),
          validateReview: () => {
            validations++;
            throw new Error('Unknown citation');
          },
        },
        fakeQuery([JSON.stringify(VALID_REVIEW)], calls),
      ),
    ).rejects.toThrow('Unknown citation');
    expect(validations).toBe(2);
    expect(calls.prompts).toHaveLength(2);
  });

  it('throws when both attempts are invalid', async () => {
    const queryFn: QueryFn = async function* () {
      yield { type: 'result', subtype: 'success', result: 'still not json' } as SDKMessage;
    };
    await expect(runClaudeReviewWithRetry(opts(), queryFn)).rejects.toThrow();
  });
});
