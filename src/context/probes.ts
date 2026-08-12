import { posix } from 'node:path';
import type { FileDiff } from '../util/diff.js';

export interface Probes {
  paths: string[];
  basenames: string[];
  symbols: string[];
  imports: string[];
  routes: string[];
  tables: string[];
}

const SYMBOL_RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'function', re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];

const IMPORT_RES = [/(?:from|import)\s+['"]([^'"]+)['"]/, /require\(\s*['"]([^'"]+)['"]\s*\)/];

const ROUTE_RES = /['"`]([^'"`]*\/api\/[^'"`]*)['"`]/;

const CREATE_TABLE_RES = /create\s+table(?:\s+if\s+not\s+exists)?\s+([A-Za-z_]\w*)/i;

/** `schema.table` only when it directly follows a SQL keyword — precision over noise. */
const SCHEMA_TABLE_RES = /(?:from|join|into|update|table)\s+([A-Za-z_]\w*\.\w+)/i;

const LIMITS = { symbols: 40, imports: 30, routes: 20, tables: 10 };

// Packages → name (or @scope/name); relative imports stay as-is.
function normalizeImport(specifier: string): string {
  if (specifier.startsWith('.')) return specifier;
  const [head, second] = specifier.split('/');
  if (!head) return specifier;
  return head.startsWith('@') && second ? `${head}/${second}` : head;
}

export function extractProbes(files: FileDiff[]): Probes {
  const paths = new Set<string>();
  const basenames = new Set<string>();
  const symbols = new Set<string>();
  const imports = new Set<string>();
  const routes = new Set<string>();
  const tables = new Set<string>();

  for (const file of files) {
    for (const p of [file.path, file.oldPath]) {
      if (p) {
        paths.add(p);
        basenames.add(posix.basename(p));
      }
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'context') continue;
        const text = line.text;

        for (const rule of SYMBOL_RULES) {
          const m = rule.re.exec(text);
          if (m?.[1]) {
            symbols.add(m[1]);
            break; // at most one symbol per line
          }
        }
        for (const re of IMPORT_RES) {
          const m = re.exec(text);
          if (m?.[1]) imports.add(normalizeImport(m[1]));
        }
        const route = ROUTE_RES.exec(text);
        if (route?.[1]) routes.add(route[1]);
        const table = CREATE_TABLE_RES.exec(text);
        if (table?.[1]) tables.add(table[1]);
        const schemaTable = SCHEMA_TABLE_RES.exec(text);
        if (schemaTable?.[1]) tables.add(schemaTable[1]);
      }
    }
  }

  return {
    paths: [...paths],
    basenames: [...basenames],
    symbols: [...symbols].slice(0, LIMITS.symbols),
    imports: [...imports].slice(0, LIMITS.imports),
    routes: [...routes].slice(0, LIMITS.routes),
    tables: [...tables].slice(0, LIMITS.tables),
  };
}
