import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;
}

describe('tooling setup', () => {
  it('provides the complete local quality gate scripts', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };

    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(pkg.scripts['lint:fix']).toBe('eslint . --fix');
    expect(pkg.scripts.format).toBe('prettier --write .');
    expect(pkg.scripts['format:check']).toBe('prettier --check .');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.ci).toContain('npm run typecheck');
    expect(pkg.scripts.ci).toContain('npm run lint');
    expect(pkg.scripts.ci).toContain('npm run format:check');
    expect(pkg.scripts.ci).toContain('npm test');
  });

  it('declares the required lint and format dependencies', () => {
    const pkg = readJson('package.json') as { devDependencies: Record<string, string> };

    expect(pkg.devDependencies.eslint).toBeDefined();
    expect(pkg.devDependencies.prettier).toBeDefined();
    expect(pkg.devDependencies['typescript-eslint']).toBeDefined();
    expect(pkg.devDependencies['@eslint/js']).toBeDefined();
    expect(pkg.devDependencies['eslint-config-prettier']).toBeDefined();
    expect(pkg.devDependencies['eslint-plugin-import']).toBeDefined();
  });

  it('includes the contributor documentation and tooling configuration', () => {
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('Quality checks');
    expect(readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')).toContain('Quality checks');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('Unreleased');
    expect(readFileSync(join(root, 'eslint.config.js'), 'utf8')).toContain('typescript-eslint');
    expect(readFileSync(join(root, '.prettierrc.json'), 'utf8')).toContain('singleQuote');
  });
  it('documents runnable entry points and an isolated compiled demo', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['demo:local']).toBe('npm run build && node scripts/demo-local.mjs');
    expect(pkg.scripts['smoke:compiled']).toBe('node scripts/demo-local.mjs');
    const guide = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    expect(guide).toContain('cd Peer');
    expect(guide).not.toContain('cd OstryaAIOA');
    expect(guide).toContain('npm run demo:local');
    expect(guide).toContain('PowerShell');
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('windows-latest');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('npm run smoke:compiled');
  });
});
