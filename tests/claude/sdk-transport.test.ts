import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { query, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { runClaudeReview } from '../../src/claude/runner.js';
import { loadEnv } from '../../src/config/env.js';

interface OfflineResponse {
  subtype: string;
  request_id: string;
  response: {
    behavior?: string;
    hookSpecificOutput: { permissionDecision: string };
  };
}
interface OfflineInitialize {
  subtype: string;
  hooks: { PreToolUse: { hookCallbackIds: string[] }[] };
  skills: string[];
  plugins?: unknown[];
  systemPrompt: string[];
}
interface OfflineMessage {
  type: string;
  request_id: string;
  request: OfflineInitialize;
  response: OfflineResponse;
}

// Exercise the installed SDK's real JSON transport, without launching Claude,
// accessing credentials or a network, or calling a model.
class OfflineCli extends EventEmitter {
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  responses: Record<string, OfflineResponse> = {};
  initialization!: OfflineInitialize;
  private buffer = '';
  private started = false;
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.buffer += chunk.toString();
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.receive(JSON.parse(line));
      }
      done();
    },
  });
  private send(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  private receive(message: OfflineMessage) {
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      this.initialization = message.request;
      this.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {},
        },
      });
    } else if (message.type === 'user' && !this.started) {
      this.started = true;
      const callback = this.initialization.hooks.PreToolUse[0].hookCallbackIds[0];
      for (const [id, tool, input] of [
        ['read', 'Read', { file_path: 'diff.txt' }],
        ['grep', 'Grep', { pattern: 'packed' }],
        ['glob', 'Glob', { pattern: '**/*.txt' }],
        ['write', 'Write', { file_path: 'diff.txt', content: 'bad' }],
        ['escape', 'Read', { file_path: '../secret.txt' }],
      ] as const) {
        this.send({
          type: 'control_request',
          request_id: id,
          request: {
            subtype: 'can_use_tool',
            tool_name: tool,
            input,
            tool_use_id: id,
          },
        });
        this.send({
          type: 'control_request',
          request_id: `hook-${id}`,
          request: {
            subtype: 'hook_callback',
            callback_id: callback,
            tool_use_id: id,
            input: {
              hook_event_name: 'PreToolUse',
              session_id: 'offline',
              transcript_path: '',
              cwd: '.',
              tool_name: tool,
              tool_input: input,
              tool_use_id: id,
            },
          },
        });
      }
    } else if (message.type === 'control_response') {
      this.responses[message.response.request_id] = message.response;
      if (Object.keys(this.responses).length === 10) {
        this.send({
          type: 'result',
          subtype: 'success',
          result: 'offline-result',
          session_id: 'offline',
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        });
        this.exitCode = 0;
        this.stdout.end();
        this.emit('exit', 0, null);
      }
    }
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    this.emit('exit', 0, null);
    return true;
  }
}

describe('installed SDK offline transport boundary', () => {
  it('forwards isolated options and dispatches permission and hook guards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-sdk-transport-'));
    const workspaceDir = join(dir, 'job');
    mkdirSync(workspaceDir);
    writeFileSync(join(workspaceDir, 'diff.txt'), 'packed');
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    const cli = new OfflineCli();
    let spawn: SpawnOptions | undefined;
    try {
      const result = await runClaudeReview(
        {
          env: loadEnv({}),
          workspaceDir,
          systemPrompt: 'offline system',
          prompt: 'offline prompt',
        },
        (params) =>
          query({
            ...params,
            options: {
              ...params.options,
              spawnClaudeCodeProcess: (options) => {
                spawn = options;
                return cli as unknown as SpawnedProcess;
              },
            },
          }),
      );
      expect(result).toBe('offline-result');
      expect(spawn?.cwd).toBe(workspaceDir);
      const args = spawn!.args;
      const argument = (flag: string) => args[args.indexOf(flag) + 1];
      expect(argument('--tools')).toBe('Read,Grep,Glob');
      expect(args).not.toContain('--allowedTools');
      expect(argument('--permission-mode')).toBe('default');
      expect(argument('--permission-prompt-tool')).toBe('stdio');
      expect(args).toContain('--setting-sources=');
      expect(args).toContain('--strict-mcp-config');
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain('--plugin-dir');
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(cli.initialization.skills).toEqual([]);
      expect(cli.initialization.plugins ?? []).toEqual([]);
      expect(cli.initialization.systemPrompt).toEqual(['offline system']);
      for (const id of ['read', 'grep', 'glob', 'write', 'escape']) {
        const expected = ['write', 'escape'].includes(id) ? 'deny' : 'allow';
        expect(cli.responses[id].subtype).toBe('success');
        expect(cli.responses[id].response.behavior).toBe(expected);
        expect(cli.responses[`hook-${id}`].response.hookSpecificOutput.permissionDecision).toBe(
          expected,
        );
      }
    } finally {
      cli.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
