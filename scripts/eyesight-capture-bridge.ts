import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Plugin } from 'vite';

const studio = '/Applications/Studio 2.0/PhotoRealisticRenderer/mac';
const binary = join(studio, 'eyesight.app/Contents/MacOS/eyesight');

/** Run the installed renderer with its own unmodified material and film settings. */
export async function renderNativeEyeSight(dae: string, width: number, height: number, samples: number, signal?: AbortSignal): Promise<Buffer> {
  if (!existsSync(binary)) throw new Error('Install BrickLink Studio on this Mac to use native EyeSight.');
  const dir = await mkdtemp(join(tmpdir(), 'brickmotion-eyesight-'));
  const input = join(dir, 'capture.dae'), output = join(dir, 'capture.png');
  try {
    await writeFile(input, dae);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [
        '--daewindingorder', 'counterclockwise', '--autoexit', '--dae-overlap-tolerant', '--device', 'CPU',
        '--width', String(width), '--height', String(height), '--samples', String(samples),
        '--shadow-ground', '--param', '0', '1 1 1', '--defaultlight', '--preset', 'BUILD_FL',
        '--light-rotz', '0', '--light-intensity', '0.7', '--daefile', input, '--output', output,
        join(studio, 'settings_v1.xml'), join(studio, 'LEGO_StudioSet.xml'),
      ], { cwd: studio, stdio: 'ignore' });
      let settled = false, polling = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearInterval(timer); clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
        child.kill('SIGKILL');
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error('EyeSight capture cancelled.'));
      // EyeSight can hang after saving. A complete PNG's IEND marks safe readback.
      const complete = async () => {
        try {
          const bytes = await readFile(output);
          return bytes.length > 12 && bytes.subarray(-8, -4).toString() === 'IEND';
        } catch { return false; }
      };
      const timer = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try { if (await complete()) finish(); } finally { polling = false; }
      }, 1000);
      const deadline = setTimeout(() => finish(new Error('EyeSight timed out after 30 minutes.')), 30 * 60_000);
      child.once('error', finish);
      child.once('exit', () => { void complete().then(ok => finish(ok ? undefined : new Error('EyeSight exited without a complete image.'))); });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function eyesightCaptureBridge(): Plugin {
  let busy = false;
  return { name: 'eyesight-capture-bridge', configureServer(server) {
    server.middlewares.use('/__eyesight/capture', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) { res.statusCode = 403; res.end(); return; }
      if (busy) { res.statusCode = 409; res.end('An EyeSight capture is already running.'); return; }
      const query = new URL(req.url ?? '', 'http://local').searchParams;
      const width = Number(query.get('width')), height = Number(query.get('height')), samples = Number(query.get('samples'));
      if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096) || ![64, 256, 1024].includes(samples)) { res.statusCode = 400; res.end('Invalid render size or samples.'); return; }
      let size = 0; const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) { res.statusCode = 413; res.end('Scene is too large.'); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        const dae = Buffer.concat(chunks).toString('utf8');
        if (!dae.includes('<COLLADA') || /<!DOCTYPE|<!ENTITY|<image\b/i.test(dae)) { res.statusCode = 400; res.end('Expected a self-contained COLLADA scene.'); return; }
        if (busy) { res.statusCode = 409; res.end('An EyeSight capture is already running.'); return; }
        busy = true;
        const controller = new AbortController();
        const cancel = () => controller.abort(); res.on('close', cancel);
        try {
          const png = await renderNativeEyeSight(dae, width, height, samples, controller.signal);
          res.setHeader('Content-Type', 'image/png'); res.end(png);
        } catch (error) { if (!res.destroyed) { res.statusCode = 500; res.end((error as Error).message); } }
        finally { busy = false; res.off('close', cancel); }
      });
    });
  } };
}
