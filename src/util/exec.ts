import { execa, type Options } from 'execa';

export interface RunGitOptions extends Options {
  /** Secrets to scrub from error messages (e.g. the installation token in clone URLs). */
  redact?: string[];
}

// Runs a git command; secrets passed via `redact` are scrubbed (***) from errors.
export async function runGit(args: string[], options: RunGitOptions = {}): Promise<string> {
  const { redact, ...execaOptions } = options;
  try {
    const { stdout } = await execa('git', args, {
      ...execaOptions,
      env: { GIT_TERMINAL_PROMPT: '0', ...execaOptions.env },
    });
    // execa's stdout is conditionally typed; with default options it is always a string.
    return typeof stdout === 'string' ? stdout : '';
  } catch (err) {
    const stderr = (err as { stderr?: unknown })?.stderr;
    const detail = typeof stderr === 'string' ? stderr.trim() : (err as Error).message;
    let message = `git ${args.join(' ')} failed: ${detail}`;
    for (const secret of redact ?? []) {
      if (secret) message = message.split(secret).join('***');
    }
    throw new Error(message);
  }
}
