import { readFileSync } from 'node:fs';
import { App } from 'octokit';
import type { Env } from '../config/env.js';

/** Build the GitHub App client: app id + PEM private key (file or base64). */
export function createApp(env: Env): App {
  const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_PRIVATE_KEY } = env;
  if (!GITHUB_APP_ID) {
    throw new Error('GITHUB_APP_ID is not set — see .env.example.');
  }

  let privateKey: string;
  if (GITHUB_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(GITHUB_PRIVATE_KEY_PATH, 'utf8');
    } catch (err) {
      throw new Error(
        `Cannot read GitHub App private key at "${GITHUB_PRIVATE_KEY_PATH}": ${(err as Error).message}`,
      );
    }
  } else if (GITHUB_PRIVATE_KEY) {
    privateKey = Buffer.from(GITHUB_PRIVATE_KEY, 'base64').toString('utf8');
  } else {
    throw new Error('No GitHub App private key — set GITHUB_PRIVATE_KEY_PATH (or GITHUB_PRIVATE_KEY).');
  }

  if (!privateKey.includes('-----BEGIN')) {
    throw new Error(
      'The GitHub App private key is invalid — expected a PEM key beginning with "-----BEGIN ...".',
    );
  }

  return new App({ appId: GITHUB_APP_ID, privateKey });
}
