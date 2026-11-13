import { execFile } from 'node:child_process';
import type { Plugin, Connect } from 'vite';

/** Keep filesystem updates on the local server, rather than in the browser. */
export function partsUpdateBridge(): Plugin {
  let running: Promise<string> | null = null;
  const run = (check: boolean, root: string) => new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', 'scripts/update-parts.ts', ...(check ? ['--check'] : ['--unofficial', '--studio'])],
      { cwd: root, timeout: 900_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      });
  });
  const install = (middlewares: Connect.Server, root: string) => {
    middlewares.use('/api/parts-update', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // Only same-origin requests may trigger a library write.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        res.statusCode = 403; res.end(JSON.stringify({ error: 'Origin rejected' })); return;
      }
      try {
        if (req.method === 'GET') {
          if (running) { res.end(JSON.stringify({ updating: true })); return; }
          const output = await run(true, root);
          res.end(JSON.stringify({ available: output.includes('a new library is available') }));
        } else if (req.method === 'POST') {
          running ??= run(false, root).finally(() => { running = null; });
          await running;
          res.end(JSON.stringify({ updated: true }));
        } else { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); }
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  };
  return {
    name: 'parts-update-bridge',
    configureServer(server) { install(server.middlewares, server.config.root); },
    configurePreviewServer(server) { install(server.middlewares, server.config.root); },
  };
}
