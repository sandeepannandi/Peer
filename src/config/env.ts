import { z } from 'zod';

export const EnvSchema = z
  .object({
    // GitHub App
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    GITHUB_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_ORG: z.string().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),

    // Claude Code (subscription auth via `claude login`)
    CLAUDE_MODEL: z.string().min(1).default('sonnet'),
    CLAUDE_MAX_TURNS: z.coerce.number().int().positive().default(30),

    // Context pack
    REVIEW_MAX_CONTEXT_FILES: z.coerce.number().int().positive().default(12),
    CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(40000),
    MAX_REVIEW_COMMENTS: z.coerce.number().int().positive().default(20),

    // Paths / logging
    DATA_DIR: z.string().min(1).default('./data'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    const keyPath = env.GITHUB_PRIVATE_KEY_PATH;
    const keyInline = env.GITHUB_PRIVATE_KEY;
    if (keyPath && keyInline) {
      ctx.addIssue({
        code: 'custom',
        message: 'Set only one of GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY.',
      });
    }
    if (env.GITHUB_APP_ID && !keyPath && !keyInline) {
      ctx.addIssue({
        code: 'custom',
        message:
          'GITHUB_APP_ID is set but no private key — set GITHUB_PRIVATE_KEY_PATH (or GITHUB_PRIVATE_KEY).',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

// Load and validate config; fail fast if ANTHROPIC_API_KEY is set (Claude Code only).
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is set — Peer reviews via Claude Code (your Claude ' +
        'subscription), not the Anthropic API. Unset ANTHROPIC_API_KEY and use ' +
        '`claude login` instead.',
    );
  }
  // Empty strings are treated as unset: a fresh .env.example has empty placeholders.
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') {
      raw[key] = value;
    }
  }
  return EnvSchema.parse(raw);
}
