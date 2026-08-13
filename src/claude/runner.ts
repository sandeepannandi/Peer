import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Env } from '../config/env.js';
import { parseReviewText, type Review } from '../review/schema.js';

// Claude can analyse the workspace but never modify it.
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git:*)'] as const;

export interface ClaudeRunOptions {
  env: Env;
  /** Job workspace: numbered diff + context pack (read-only for Claude). */
  workspaceDir: string;
  systemPrompt: string;
  prompt: string;
}

/** Minimal shape of the SDK query() — injectable for tests. */
export interface QueryFn {
  (params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
}

// Headless Claude Code session (auth via `claude login`) → the final assistant text.
export async function runClaudeReview(opts: ClaudeRunOptions, queryFn: QueryFn = query): Promise<string> {
  const stream = queryFn({
    prompt: opts.prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      model: opts.env.CLAUDE_MODEL,
      cwd: opts.workspaceDir,
      allowedTools: [...READ_ONLY_TOOLS],
      permissionMode: 'bypassPermissions',
      maxTurns: opts.env.CLAUDE_MAX_TURNS,
    },
  });

  let result = '';
  for await (const message of stream) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message.result;
      } else {
        throw new Error(`Claude Code review failed: ${message.errors.join('; ') || message.subtype}`);
      }
    }
  }
  if (!result) {
    throw new Error('Claude Code returned no final result.');
  }
  return result;
}

// Run the review, validate the JSON, retry once with a repair prompt on failure.
export async function runClaudeReviewWithRetry(opts: ClaudeRunOptions, queryFn: QueryFn = query): Promise<Review> {
  const first = await runClaudeReview(opts, queryFn);
  try {
    return parseReviewText(first);
  } catch (err) {
    const repair = `${opts.prompt}\n\nYour previous response could not be parsed as a valid review (${(err as Error).message}). Reply with ONLY the corrected JSON object matching the schema — no prose, no markdown fences.`;
    const second = await runClaudeReview({ ...opts, prompt: repair }, queryFn);
    return parseReviewText(second);
  }
}
