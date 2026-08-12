import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadEnv({});
    expect(env.CLAUDE_MODEL).toBe('sonnet');
    expect(env.CLAUDE_MAX_TURNS).toBe(30);
    expect(env.REVIEW_MAX_CONTEXT_FILES).toBe(12);
    expect(env.CONTEXT_TOKEN_BUDGET).toBe(40000);
    expect(env.MAX_REVIEW_COMMENTS).toBe(20);
    expect(env.DATA_DIR).toBe('./data');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('parses numeric env values', () => {
    const env = loadEnv({
      GITHUB_APP_ID: '123456',
      GITHUB_PRIVATE_KEY_PATH: 'key.pem',
      CLAUDE_MAX_TURNS: '50',
    });
    expect(env.GITHUB_APP_ID).toBe(123456);
    expect(env.CLAUDE_MAX_TURNS).toBe(50);
  });

  it('fails fast when ANTHROPIC_API_KEY is set', () => {
    expect(() => loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-abc123' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('treats empty-string values as unset (copied .env.example)', () => {
    const env = loadEnv({
      GITHUB_APP_ID: '',
      GITHUB_PRIVATE_KEY_PATH: '',
      CLAUDE_MAX_TURNS: '',
      DATA_DIR: '  ',
    });
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.CLAUDE_MAX_TURNS).toBe(30);
    expect(env.DATA_DIR).toBe('./data');
  });

  it('rejects both private key variants being set at once', () => {
    expect(() =>
      loadEnv({ GITHUB_PRIVATE_KEY_PATH: 'key.pem', GITHUB_PRIVATE_KEY: 'Zm9v' }),
    ).toThrow(/Set only one/);
  });

  it('accepts a private key path together with an app id', () => {
    const env = loadEnv({ GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY_PATH: 'key.pem' });
    expect(env.GITHUB_PRIVATE_KEY_PATH).toBe('key.pem');
  });
});
