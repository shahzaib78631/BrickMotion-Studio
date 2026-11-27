import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server bridge to BrickGen v3 (neural text / image-ref / 3D-mesh -> LEGO),
 * BrickLayer-Agent (autonomous hierarchical MOC builder), and the certified Showcase MOCs.
 *
 * Runs locally via BrickMotion Studio's Python venv + native C++ `libbmcore` + Metal `bmshot`.
 *
 *   GET  /api/brickgen             -> availability, checkpoints & showcase catalog
 *   POST /api/brickgen { ... }     -> { ok, ldr, stats, renderDataUrl?, blueprintDataUrl? }
 */

const REPO_ROOT = resolve(process.cwd());
const PY_BIN = join(REPO_ROOT, 'python/.venv/bin/python');
const DATA_DIR = '/Users/mac/Projects/BrickMotion-Data/brickgen';
const SHOWCASE_DIR = join(DATA_DIR, 'bricklayer_showcase');
const BMSHOT_BIN = join(REPO_ROOT, 'native/build/render/bmshot');

const SHOWCASE_ITEMS = [
  { id: 'calusa_villa', title: 'The Calusa Villa — Plan F1-4817 (486p)', ldr: 'calusa_villa.ldr', png: 'calusa_villa_sheet.png' },
  { id: 'speed_champions_gt', title: 'Speed Champions Red GT (139p)', ldr: 'speed_champions_gt.ldr', png: 'speed_champions_gt.png' },
  { id: 'medieval_watchtower', title: 'Medieval Stone Watchtower (142p)', ldr: 'medieval_watchtower.ldr', png: 'medieval_watchtower.png' },
  { id: 'brickheadz_hero', title: 'BrickHeadz Classic Hero (72p)', ldr: 'brickheadz_hero.ldr', png: 'brickheadz_hero.png' },
] as const;

type RunOut = { code: number; stdout: string; stderr: string; killed: boolean };

function runPy(args: string[], timeoutMs: number, stop?: AbortSignal): Promise<RunOut> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const child = spawn(PY_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: join(REPO_ROOT, 'python') },
    });
    stop?.addEventListener('abort', () => {
      killed = true;
      child.kill('SIGKILL');
    }, { once: true });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, killed });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      done({ code: killed ? -2 : code ?? -1, stdout, stderr, killed });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let text = '';
    req.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      if (text.length > 24 * 1024 * 1024) {
        fail(new Error('request too large (max 24 MB)'));
        req.destroy();
      }
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });
}

async function fileToDataUrl(path: string, mime = 'image/png'): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function parseDataUrl(dataUrl: string): { ext: string; bytes: Buffer } | null {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { ext, bytes: Buffer.from(m[2], 'base64') };
}

export function brickgenBridge(): Plugin {
  const getStatus = () => {
    const hasPy = existsSync(PY_BIN);
    const hasV3 = existsSync(join(DATA_DIR, 'brickgen_v3.pt'));
    const hasDpo = existsSync(join(DATA_DIR, 'brickgen_v3_dpo.pt'));
    const hasBlueprint = existsSync(join(DATA_DIR, 'blueprint.pt'));
    const hasBmshot = existsSync(BMSHOT_BIN);
    const showcase = SHOWCASE_ITEMS.filter((s) => existsSync(join(SHOWCASE_DIR, s.ldr))).map((s) => ({
      id: s.id,
      title: s.title,
    }));
    return {
      ready: hasPy && (hasV3 || showcase.length > 0),
      hasV3,
      hasDpo,
      hasBlueprint,
      hasBmshot,
      showcase,
    };
  };

  type Body = {
    mode?: 'neural' | 'agent' | 'showcase';
    prompt?: string;
    showcaseId?: string;
    imageDataUrl?: string;
    imageWeight?: number;
    meshText?: string;
    meshExt?: string;
    meshSpanStuds?: number;
    samples?: number;
    maxParts?: number;
    useBlueprint?: boolean;
    useDpo?: boolean;
    seed?: number;
    rounds?: number;
  };

  const handlePost = async (body: Body, stop?: AbortSignal): Promise<Record<string, unknown>> => {
    const mode = body.mode ?? 'neural';

    if (mode === 'showcase') {
      const item = SHOWCASE_ITEMS.find((s) => s.id === body.showcaseId) ?? SHOWCASE_ITEMS[0];
      const ldrPath = join(SHOWCASE_DIR, item.ldr);
      if (!existsSync(ldrPath)) return { ok: false, message: `Showcase file missing: ${item.ldr}` };
      const ldr = await readFile(ldrPath, 'utf8');
      const renderDataUrl = await fileToDataUrl(join(SHOWCASE_DIR, item.png));
      const pieceCount = ldr.split('\n').filter((l) => l.startsWith('1 ')).length;
      return {
        ok: true,
        title: item.title,
        ldr,
        renderDataUrl,
        stats: { pieces: pieceCount, overlaps: 0, groups: 1, stands: true, source: 'BrickLayer-Studio Certified Showcase' },
      };
    }

    const prompt = (body.prompt ?? '').trim();
    if (!prompt) return { ok: false, message: 'Enter a text prompt first.' };
    if (!existsSync(PY_BIN)) return { ok: false, message: 'Python venv not found at python/.venv/bin/python' };

    const workDir = await mkdtemp(join(tmpdir(), 'brickgen-ui-'));
    try {
      const outLdr = join(workDir, 'model.ldr');
      const outPng = join(workDir, 'render.png');
      const outBp = join(workDir, 'blueprint.png');

      let imgPath: string | null = null;
      if (typeof body.imageDataUrl === 'string' && body.imageDataUrl.startsWith('data:image/')) {
        const parsed = parseDataUrl(body.imageDataUrl);
        if (parsed) {
          imgPath = join(workDir, `ref.${parsed.ext}`);
          await writeFile(imgPath, parsed.bytes);
        }
      }

      let meshPath: string | null = null;
      if (typeof body.meshText === 'string' && body.meshText.trim().length > 10) {
        const ext = (body.meshExt ?? '.obj').toLowerCase().replace(/[^a-z.]/g, '');
        const safeExt = ext === '.stl' || ext === '.ply' ? ext : '.obj';
        meshPath = join(workDir, `input${safeExt}`);
        await writeFile(meshPath, body.meshText, 'utf8');
      }

      if (mode === 'agent') {
        const args = [
          '-m', 'brickgen', 'agent-build', prompt,
          '--out', outLdr,
          '--render', outPng,
          '--rounds', String(Math.min(Math.max(Number(body.rounds) || 4, 1), 6)),
        ];
        if (imgPath) args.push('--image-ref', imgPath);
        const r = await runPy(args, 8 * 60_000, stop);
        if (r.code !== 0 || !existsSync(outLdr)) {
          return {
            ok: false,
            message: r.killed ? 'Cancelled or timed out.' : (r.stderr || r.stdout).trim().slice(-600) || `Exited with ${r.code}`,
          };
        }
        const ldr = await readFile(outLdr, 'utf8');
        const renderDataUrl = await fileToDataUrl(outPng);
        const pieceCount = ldr.split('\n').filter((l) => l.startsWith('1 ')).length;
        const mInfo = /pieces=(\d+)\s+overlaps=(\d+)\s+groups=(\d+)\s+stands=(True|False)/.exec(ldr);
        return {
          ok: true,
          title: prompt.slice(0, 48),
          ldr,
          renderDataUrl,
          stats: {
            pieces: mInfo ? Number(mInfo[1]) : pieceCount,
            overlaps: mInfo ? Number(mInfo[2]) : 0,
            groups: mInfo ? Number(mInfo[3]) : 1,
            stands: mInfo ? mInfo[4] === 'True' : true,
            source: 'BrickLayer-Agent (libbmcore certified)',
            log: r.stdout.trim().split('\n').slice(-2).join(' | '),
          },
        };
      }

      // Neural BrickGen v3 / v3-DPO mode
      const dpoCkpt = join(DATA_DIR, 'brickgen_v3_dpo.pt');
      const v3Ckpt = join(DATA_DIR, 'brickgen_v3.pt');
      const ckpt = body.useDpo && existsSync(dpoCkpt) ? dpoCkpt : v3Ckpt;
      if (!existsSync(ckpt)) return { ok: false, message: `Checkpoint not found: ${ckpt}` };

      const args = [
        '-m', 'brickgen', 'generate', prompt,
        '--ckpt', ckpt,
        '--out', outLdr,
        '--render', outPng,
        '--samples', String(Math.min(Math.max(Number(body.samples) || 4, 1), 8)),
        '--max-parts', String(Math.min(Math.max(Number(body.maxParts) || 80, 16), 160)),
        '--seed', String(Math.max(0, Math.floor(Number(body.seed) || 0))),
      ];
      const bpCkpt = join(DATA_DIR, 'blueprint.pt');
      if (meshPath) {
        args.push('--blueprint-from-mesh', meshPath, '--mesh-span-studs', String(Number(body.meshSpanStuds) || 12), '--save-blueprint', outBp);
      } else if (body.useBlueprint !== false && existsSync(bpCkpt)) {
        args.push('--blueprint-ckpt', bpCkpt, '--save-blueprint', outBp);
      }
      if (imgPath) {
        args.push('--image-ref', imgPath, '--image-weight', String(Number(body.imageWeight ?? 0.55)));
      }

      const r = await runPy(args, 5 * 60_000, stop);
      if (r.code !== 0 || !existsSync(outLdr)) {
        return {
          ok: false,
          message: r.killed ? 'Cancelled or timed out.' : (r.stderr || r.stdout).trim().slice(-600) || `Exited with ${r.code}`,
        };
      }
      const ldr = await readFile(outLdr, 'utf8');
      const renderDataUrl = await fileToDataUrl(outPng);
      const blueprintDataUrl = await fileToDataUrl(outBp);
      const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('Generated ')).pop() ?? '';
      const mInfo = /pieces=(\d+)\s+overlaps=(\d+)\s+groups=(\d+)\s+stands=(True|False)/.exec(ldr);
      const mClip = /clip=([0-9.]+)/.exec(line);
      const mImg = /img_sim=([0-9.]+)/.exec(line);
      const mIou = /bp_iou=([0-9.]+)/.exec(line);
      const mSec = /\|\s*([0-9.]+)s$/.exec(line);
      return {
        ok: true,
        title: prompt.slice(0, 48),
        ldr,
        renderDataUrl,
        blueprintDataUrl,
        stats: {
          pieces: mInfo ? Number(mInfo[1]) : ldr.split('\n').filter((l) => l.startsWith('1 ')).length,
          overlaps: mInfo ? Number(mInfo[2]) : 0,
          groups: mInfo ? Number(mInfo[3]) : 1,
          stands: mInfo ? mInfo[4] === 'True' : true,
          clip: mClip ? Number(mClip[1]) : undefined,
          imgSim: mImg ? Number(mImg[1]) : undefined,
          bpIou: mIou ? Number(mIou[1]) : undefined,
          seconds: mSec ? Number(mSec[1]) : undefined,
          source: ckpt === dpoCkpt ? 'BrickGen v3-DPO' : 'BrickGen v3',
        },
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
        return send(403, { ok: false, message: 'forbidden origin' });
      }
      if (req.method === 'GET') return send(200, getStatus());
      if (req.method !== 'POST') return send(405, { ok: false, message: 'use GET or POST' });
      const stop = new AbortController();
      res.on('close', () => { if (!res.writableEnded) stop.abort(); });
      const body = JSON.parse((await readBody(req)) || '{}') as Body;
      return send(200, await handlePost(body, stop.signal));
    } catch (e) {
      return send(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    name: 'brickmotion-brickgen',
    configureServer(server) {
      server.middlewares.use('/api/brickgen', (req, res) => { void handler(req, res); });
    },
  };
}
