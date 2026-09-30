import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** SDK tool policy, not an OS sandbox. The host must own the job workspace. */
export function createReviewToolPolicy(workspaceDir: string): {
  beforeTool: HookCallback;
  canUseTool: CanUseTool;
} {
  const root = realpathSync(workspaceDir);
  if (!lstatSync(root).isDirectory()) throw new Error('Review workspace must be a directory.');

  function withinRoot(path: string): boolean {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  function safePath(value: unknown): string {
    if (typeof value !== 'string' || !value || value.includes('\0')) {
      throw new Error('Missing or invalid tool path.');
    }
    // Reject alternate path syntax, traversal and home expansion rather than
    // relying on the SDK/tool to interpret them identically on every platform.
    if (value.includes('\\') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
      throw new Error('Unsupported tool path.');
    }
    if (value.split('/').includes('..')) throw new Error('Path traversal denied.');
    const target = resolve(root, value);
    if (!withinRoot(target)) throw new Error('Path outside review workspace.');
    let current = root;
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlinks denied.');
    }
    if (!withinRoot(realpathSync(target))) throw new Error('Path outside review workspace.');
    return target;
  }

  function checkTree(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symlinks denied.');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) checkTree(resolve(path, name));
    } else if (!stat.isFile()) {
      throw new Error('Only regular files and directories may be inspected.');
    }
  }

  function denial(tool: string, input: unknown): string | undefined {
    try {
      // Fail closed if the host replaced the job directory during the session.
      if (realpathSync(workspaceDir) !== root || lstatSync(root).isSymbolicLink()) {
        throw new Error('Review workspace changed.');
      }
      if (!READ_ONLY_TOOLS.some((name) => name === tool)) {
        throw new Error('Only Read, Grep and Glob are permitted.');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid tool input.');
      }
      const args = input as Record<string, unknown>;
      if (tool === 'Read') {
        if (!lstatSync(safePath(args.file_path)).isFile()) {
          throw new Error('Read requires a regular file.');
        }
      } else {
        const target = safePath(args.path === undefined ? '.' : args.path);
        if (tool === 'Glob') {
          if (
            typeof args.pattern !== 'string' ||
            !args.pattern ||
            args.pattern.includes('\0') ||
            args.pattern.includes('\\') ||
            args.pattern.includes('..') ||
            args.pattern.includes('~') ||
            args.pattern.includes(':') ||
            /[{}()]/.test(args.pattern) ||
            isAbsolute(args.pattern)
          ) {
            throw new Error('Unsafe glob pattern.');
          }
        }
        // Search tools can follow nested links. Reject the whole searched tree
        // if it contains a link or special file, rather than risk reading outside.
        checkTree(target);
      }
      return undefined;
    } catch {
      return 'Tool denied: only regular files inside this review workspace may be inspected.';
    }
  }

  return {
    beforeTool: async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const reason = denial(input.tool_name, input.tool_input);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: reason ? 'deny' : 'allow',
          ...(reason ? { permissionDecisionReason: reason } : {}),
        },
      };
    },
    canUseTool: async (tool, input) => {
      const reason = denial(tool, input);
      return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow' };
    },
  };
}
