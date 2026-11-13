import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Dev-server bridge for the **Bricksafe models** panel: runs scripts/find_bricksafe_models.py
 * through `uv` (which supplies requests + beautifulsoup4) and hands the app the results.
 *
 * The scrape is server-side because a browser page cannot fetch bricksafe.com directly. The
 * script rewrites public/data/bricksafe-models.json after every match, so every GET is also
 * the live progress. It exists only while `npm run dev` runs; the client treats a missing
 * bridge as "not available".
 *
 *   GET  /api/bricksafe                        → { ready, running, result, log }
 *   POST /api/bricksafe { action, target? }    → start ('scan') or stop ('stop') a run
 */
type Options = { bin?: string; timeoutMs?: number };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(ROOT, 'scripts', 'find_bricksafe_models.py');
const RESULT = join(ROOT, 'public', 'data', 'bricksafe-models.json');
const CSV = join(ROOT, 'public', 'data', 'bricksafe-model-pages.csv');
const LOG_LINES = 60;

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

function readResult(): unknown {
  try {
    return existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function bricksafeBridge(options: Options = {}): Plugin {
  const bin = options.bin ?? process.env.UV_BIN ?? 'uv';
  const timeoutMs = options.timeoutMs ?? 60 * 60_000;
  let child: ChildProcess | null = null;
  let log: string[] = [];
  let health: Promise<{ ready: boolean; message?: string }> | null = null;

  const push = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      const text = line.trimEnd();
      if (text) log.push(text.replace(/\u001b\[[0-9;]*m/g, ''));
    }
    if (log.length > LOG_LINES) log = log.slice(-LOG_LINES);
  };

  const checkHealth = () => {
    health ??= new Promise((done) => {
      const probe = spawn(bin, ['--version'], { cwd: ROOT, env: process.env });
      let out = '';
      probe.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      probe.stderr?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      probe.on('error', () => done({ ready: false, message: `the uv command (${bin}) is not installed` }));
      probe.on('close', (code) =>
        code === 0
          ? done({ ready: existsSync(SCRIPT), message: existsSync(SCRIPT) ? undefined : 'scripts/find_bricksafe_models.py is missing' })
          : done({ ready: false, message: `uv exited ${code}: ${out.trim().slice(0, 160)}` }));
    });
    return health;
  };

  const start = async (body: { target?: unknown; delay?: unknown }) => {
    const status = await checkHealth();
    if (!status.ready) return { ok: false, message: status.message ?? 'the bridge is not available' };
    if (child) return { ok: false, message: 'a scan is already running' };
    const target = clamp(body.target, 1, 500, 100);
    const delay = clamp(body.delay, 0, 10, 1);
    log = [`scanning for up to ${target} pages…`];
    child = spawn(bin, [
      'run', '--no-project', '--quiet', '--with', 'requests', '--with', 'beautifulsoup4',
      'python', SCRIPT, '--json', RESULT, '--out', CSV, '--target', String(target), '--delay', String(delay),
    ], { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    const timer = setTimeout(() => { push(Buffer.from(`gave up after ${Math.round(timeoutMs / 60_000)} minutes`)); stop(); }, timeoutMs);
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e: Error) => { push(Buffer.from(e.message)); log.push(`could not start: ${e.message}`); });
    child.on('close', () => { clearTimeout(timer); child = null; });
    return { ok: true };
  };

  const stop = () => {
    if (!child) return { ok: false, message: 'no scan is running' };
    child.kill('SIGTERM');
    child = null;
    log.push('stopped');
    return { ok: true };
  };

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((done) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString('utf8'); if (text.length > 1e6) req.destroy(); });
    req.on('end', () => done(text));
  });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    try {
      // only this app's own pages: another site open in the browser must not start a scrape
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(403, { ok: false, message: 'forbidden origin' });
      if (req.method === 'GET') return send(200, { ...(await checkHealth()), running: !!child, result: readResult(), log: log.slice(-12) });
      if (req.method !== 'POST') return send(405, { ok: false, message: 'use GET or POST' });
      const body = JSON.parse((await readBody(req)) || '{}') as { action?: unknown; target?: unknown; delay?: unknown };
      const reply = body.action === 'stop' ? stop() : body.action === 'scan' ? await start(body) : { ok: false, message: 'unknown action' };
      return send(200, { ...reply, running: !!child, result: readResult() });
    } catch (e) {
      return send(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    name: 'brickmotion-bricksafe',
    configureServer(server) {
      server.middlewares.use('/api/bricksafe', (req, res) => { void handler(req, res); });
      server.httpServer?.on('close', () => child?.kill('SIGTERM'));
    },
  };
}
