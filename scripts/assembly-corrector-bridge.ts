import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server bridge to the Assembly Corrector — the LDraw step planner in
 * `assembly-corrector/ldraw_autostep.py`.
 *
 * A browser cannot run Python, so the *dev server* runs it: this middleware takes the
 * model as an LDraw document, plans it with the local engine and hands back both the
 * corrected document and its diagnosis JSON. It exists only while `npm run dev` runs,
 * and the client treats a missing bridge as "engine not available" rather than failing
 * silently.
 *
 *   GET  /api/assembly-corrector            → is the engine usable here?
 *   POST /api/assembly-corrector { mpd, name, maxStep? } → run it once
 */
type BridgeOptions = { root?: string; timeoutMs?: number };
type Run = { code: number; stdout: string; stderr: string; killed?: boolean };

export function assemblyCorrectorBridge(options: BridgeOptions = {}): Plugin {
  const root = options.root ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const script = process.env.CORRECTOR_SCRIPT ?? join(root, 'assembly-corrector', 'ldraw_autostep.py');
  const ldraw = process.env.CORRECTOR_LDRAW ?? join(root, 'public', 'ldraw');
  const venvPython = join(root, 'python', '.venv', 'bin', 'python');
  const python = process.env.CORRECTOR_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python3');
  let cached: Record<string, unknown> | null = null;

  const spawnOnce = (args: string[], maxBytes = 4 * 1024 * 1024): Promise<Run> => new Promise((done) => {
    const child = spawn(python, args, { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    const keep = (text: string, chunk: Buffer) => (text.length > maxBytes ? text : text + chunk.toString('utf8'));
    child.stdout.on('data', (chunk: Buffer) => { stdout = keep(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = keep(stderr, chunk); });
    child.on('error', (error: Error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }); });
    child.on('close', (code: number | null) => { clearTimeout(timer); done({ code: killed ? -2 : code ?? -1, stdout, stderr, killed }); });
  });

  const checkHealth = async (): Promise<Record<string, unknown>> => {
    if (cached) return cached;
    if (!existsSync(script)) {
      return (cached = { ready: false, python, script, ldraw, message: `the corrector script is missing (${script})` });
    }
    const probe = await spawnOnce(['-c', 'import numpy, sys; print(sys.version.split()[0], numpy.__version__)'], 64 * 1024);
    if (probe.code !== 0) {
      const detail = (probe.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
      return (cached = {
        ready: false, python, script, ldraw,
        message: `the corrector engine cannot start: ${detail || 'python could not import numpy'}. Install it with "${python} -m pip install numpy".`,
      });
    }
    const version = probe.stdout.trim();
    return (cached = {
      ready: true, python, script, ldraw, version,
      offline: existsSync(ldraw),
      message: existsSync(ldraw)
        ? `python ${version} · local LDraw library`
        : `python ${version} · no local LDraw library (the engine will download parts)`,
    });
  };

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((done, fail) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.length > 64 * 1024 * 1024) { fail(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });

  type Request = { mpd?: unknown; name?: unknown; maxStep?: unknown };
  const plan = async (body: Request): Promise<Record<string, unknown>> => {
    const status = await checkHealth();
    if (status.ready !== true) return { ok: false, code: -1, message: status.message };
    if (typeof body.mpd !== 'string' || !body.mpd.trim()) return { ok: false, code: -1, message: 'no model to correct' };
    const name = String(body.name ?? 'model').replace(/[^\w .-]/g, '_').slice(0, 60) || 'model';
    const dir = await mkdtemp(join(tmpdir(), 'brickmotion-corrector-'));
    const inPath = join(dir, `${name}.mpd`);
    const outPath = join(dir, `${name}_steps.mpd`);
    const jsonPath = join(dir, `${name}.diagnosis.json`);
    try {
      await writeFile(inPath, body.mpd, 'utf8');
      const args = [script, inPath, '-o', outPath, '--report-json', jsonPath, '--explain'];
      const maxStep = Number(body.maxStep);
      if (Number.isFinite(maxStep) && maxStep > 0) args.push('--max-step', String(Math.round(maxStep)));
      if (existsSync(ldraw)) args.push('--ldraw', ldraw, '--offline');
      const result = await spawnOnce(args);
      const mpd = existsSync(outPath) ? await readFile(outPath, 'utf8') : null;
      const diagnosis = existsSync(jsonPath) ? await readFile(jsonPath, 'utf8') : null;
      return {
        ok: result.code === 0 && !!mpd,
        code: result.code,
        message: result.code === 0 ? undefined
          : result.killed ? `the engine did not finish within ${Math.round(timeoutMs / 1000)}s`
            : result.stderr.trim().split('\n').slice(-6).join('\n').slice(0, 2000) || `the engine exited with code ${result.code}`,
        mpd,
        diagnosis,
        stdout: result.stdout.slice(-8000),
        stderr: result.stderr.slice(-8000),
      };
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
      if (req.method === 'GET') return send(200, await checkHealth());
      if (req.method !== 'POST') return send(405, { ok: false, message: 'use GET or POST' });
      const body = JSON.parse((await readBody(req)) || '{}') as Request;
      return send(200, await plan(body));
    } catch (error) {
      return send(500, { ok: false, code: -1, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    name: 'brickmotion-assembly-corrector',
    configureServer(server) {
      server.middlewares.use('/api/assembly-corrector', (req, res) => { void handler(req, res); });
    },
  };
}
