export interface SymbolRule {
  kind: string;
  re: RegExp;
}

export const JS_SYMBOL_RULES: SymbolRule[] = [
  { kind: 'function', re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];
