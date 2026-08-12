import { describe, expect, it } from 'vitest';

import { extractProbes } from '../../src/context/probes.js';
import { parseUnifiedDiff } from '../../src/util/diff.js';

function probesFromDiff(diff: string) {
  return extractProbes(parseUnifiedDiff(diff));
}

describe('extractProbes', () => {
  it('extracts symbols, imports, routes and tables from changed lines', () => {
    const diff = [
      'diff --git a/src/users.ts b/src/users.ts',
      '--- a/src/users.ts',
      '+++ b/src/users.ts',
      '@@ -1,3 +1,10 @@',
      ' import { z } from "zod";',
      '+export function listUsers() {',
      '+  const rows = db.query("SELECT id FROM public.users");',
      '+  return http.get("/api/v2/users");',
      '+}',
      '+export class UserService {}',
      '+const MAX_PAGE = 100;',
      '+CREATE TABLE sessions (id TEXT);',
    ].join('\n');

    const probes = probesFromDiff(diff);

    expect(probes.paths).toEqual(['src/users.ts']);
    expect(probes.basenames).toEqual(['users.ts']);
    expect(probes.symbols).toEqual(['listUsers', 'UserService', 'MAX_PAGE']);
    expect(probes.imports).toEqual([]);
    expect(probes.routes).toEqual(['/api/v2/users']);
    expect(probes.tables).toEqual(['public.users', 'sessions']);
  });

  it('captures import specifiers (normalized) and skips context lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,4 @@',
      ' import { z } from "zod";',
      '+import { auth } from "@acme/shared/auth";',
      '+import { db } from "./db";',
      '+const client = require("pg").Pool;',
    ].join('\n');

    const probes = probesFromDiff(diff);

    expect(probes.imports).toEqual(['@acme/shared', './db', 'pg']);
    expect(probes.symbols).toEqual(['client']);
  });

  it('dedupes repeated probes and ignores indented declarations (precision)', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,4 @@',
      '+export function keep() {}',
      '+export function keep() {}',
      '+  const nested = 1;',
    ].join('\n');

    const probes = probesFromDiff(diff);

    expect(probes.symbols).toEqual(['keep']);
  });
});
