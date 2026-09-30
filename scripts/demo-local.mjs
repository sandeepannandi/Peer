// Credential-free compiled CLI smoke. Runs in a temporary directory on POSIX and Windows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'peer-demo-'));
const env = { ...process.env, DATA_DIR: join(dir, 'data') };
for (const key of Object.keys(env)) {
  if (/^(GITHUB_|ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_)/.test(key)) delete env[key];
}
try {
  const run = (...args) => {
    const result = spawnSync(process.execPath, [join(root, 'dist/index.js'), ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  assert.match(run('--help'), /review/);
  run(
    'review',
    '--owner',
    'acme',
    '--repo',
    'repo-a',
    '--pr',
    '1',
    '--local',
    '--fixtures',
    join(root, 'tests/fixtures'),
  );
  const workspace = join(env.DATA_DIR, 'workspace');
  const jobs = readdirSync(workspace);
  assert.equal(jobs.length, 1);
  const files = readdirSync(join(workspace, jobs[0]));
  const output = files.find((file) => file === 'review.json');
  assert.ok(output, 'Local review JSON was not saved');
  const review = JSON.parse(readFileSync(join(workspace, jobs[0], output), 'utf8'));
  assert.equal(review.overall, 'comment');
  assert.ok(review.findings.length > 0, 'Fixture consumer was not found');
  process.stdout.write(
    'Compiled offline demo passed. Deterministic fixture review, not AI quality; temporary state removed.\n',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
