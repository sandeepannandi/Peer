import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/util/exec.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-exec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runGit', () => {
  it('redacts secrets from error messages', async () => {
    let message = '';
    try {
      // Fails fast: -C points at a non-repo directory, but the command args
      // still contain the tokenized URL that must never reach logs.
      await runGit(
        [
          '-C',
          root,
          'remote',
          'set-url',
          'origin',
          'https://x-access-token:supersecret@github.com/a/b.git',
        ],
        { redact: ['supersecret'] },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('failed:');
    expect(message).not.toContain('supersecret');
    expect(message).toContain('https://x-access-token:***@github.com');
  });
});
