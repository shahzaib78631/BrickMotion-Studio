import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server endpoint the G-buffer exporter (neural.html) uploads its buffers to:
 *   POST /__neural/save?path=data/neuralshade/scene_00001/albedo.bin.gz   (raw body)
 * Only files under data/neuralshade can be written. Exists only while `npm run dev` runs.
 */
export function neuralSaveBridge(): Plugin {
  const root = resolve(process.cwd(), 'data/neuralshade');
  return {
    name: 'neural-save-bridge',
    configureServer(server) {
      server.middlewares.use('/__neural/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const rel = new URL(req.url ?? '', 'http://x').searchParams.get('path') ?? '';
        const target = resolve(process.cwd(), rel);
        if (!target.startsWith(root + '/')) { res.statusCode = 400; res.end('path must be under data/neuralshade'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.concat(chunks));
            res.end('ok');
          } catch (e) { res.statusCode = 500; res.end(String(e)); }
        });
      });
    },
  };
}
void join;
