import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server bridge to Claude through the local Claude Code CLI (`claude -p`), so the app
 * can use Claude with the user's own Claude login instead of an API key.
 *
 * Each call is one isolated, tool-less run: a system prompt, one prompt on stdin, a JSON
 * schema for the answer, no settings, MCP servers or project files, no saved session, in an
 * empty temporary folder. It exists only while `npm run dev` runs; the client treats a
 * missing bridge as "not available".
 *
 *   GET  /api/claude                                   → is the CLI usable here?
 *   POST /api/claude { system, prompt, schema, model?, effort? } → { ok, output, cost }
 */
type Options = { timeoutMs?: number; bin?: string };
type Run = { code: number; stdout: string; stderr: string; killed: boolean };

const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeBridge(options: Options = {}): Plugin {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const bin = options.bin ?? process.env.CLAUDE_BIN ?? 'claude';
  let health: Promise<Record<string, unknown>> | null = null;

  const run = (args: string[], input: string, cwd: string, stop?: AbortSignal): Promise<Run> => new Promise((done) => {
    let stdout = '', stderr = '', killed = false;
    const child = spawn(bin, args, { cwd, env: process.env });
    stop?.addEventListener('abort', () => { killed = true; child.kill('SIGKILL'); }, { once: true });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (e: Error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, killed }); });
    child.on('close', (code: number | null) => { clearTimeout(timer); done({ code: killed ? -2 : code ?? -1, stdout, stderr, killed }); });
    child.stdin.end(input);
  });

  const checkHealth = () => {
    health ??= (async () => {
      const r = await run(['--version'], '', tmpdir());
      return r.code === 0
        ? { ready: true, version: r.stdout.trim() }
        : { ready: false, message: `the Claude CLI (${bin}) is not available: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}` };
    })();
    return health;
  };

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((done, fail) => {
    let text = '';
    req.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      if (text.length > 8 * 1024 * 1024) { fail(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });

  type Body = { system?: unknown; prompt?: unknown; schema?: unknown; model?: unknown; effort?: unknown };
  const ask = async (body: Body, stop?: AbortSignal): Promise<Record<string, unknown>> => {
    const status = await checkHealth();
    if (status.ready !== true) return { ok: false, message: status.message };
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return { ok: false, message: 'no prompt' };
    const model = typeof body.model === 'string' && MODELS.has(body.model) ? body.model : 'sonnet';
    const args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence'];
    if (typeof body.system === 'string') args.push('--system-prompt', body.system);
    if (body.schema && typeof body.schema === 'object') args.push('--json-schema', JSON.stringify(body.schema));
    if (typeof body.effort === 'string' && EFFORTS.has(body.effort)) args.push('--effort', body.effort);
    const dir = await mkdtemp(join(tmpdir(), 'brickmotion-claude-'));
    try {
      const r = await run(args, body.prompt, dir, stop);
      let out: Record<string, unknown> = {};
      try { out = JSON.parse(r.stdout) as Record<string, unknown>; } catch { /* reported below */ }
      if (r.code !== 0 || out.is_error) {
        const why = r.killed ? `Claude did not answer within ${Math.round(timeoutMs / 1000)}s`
          : String(out.result ?? '') || r.stderr.trim().split('\n').slice(-4).join(' ').slice(0, 600) || `the CLI exited with code ${r.code}`;
        return { ok: false, message: why.replace(/\u001b\[[0-9;]*m/g, '') };
      }
      return { ok: true, output: out.structured_output ?? out.result, cost: out.total_cost_usd, model: Object.keys((out.modelUsage as object) ?? {})[0] };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    try {
      // only this app's own pages: another site open in the browser must not drive the CLI
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(403, { ok: false, message: 'forbidden origin' });
      if (req.method === 'GET') return send(200, await checkHealth());
      if (req.method !== 'POST') return send(405, { ok: false, message: 'use GET or POST' });
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(415, { ok: false, message: 'send JSON' });
      // the page cancelled (or closed): stop the CLI too
      const stop = new AbortController();
      res.on('close', () => { if (!res.writableEnded) stop.abort(); });
      return send(200, await ask(JSON.parse((await readBody(req)) || '{}') as Body, stop.signal));
    } catch (e) {
      return send(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    name: 'brickmotion-claude',
    configureServer(server) {
      server.middlewares.use('/api/claude', (req, res) => { void handler(req, res); });
    },
  };
}
