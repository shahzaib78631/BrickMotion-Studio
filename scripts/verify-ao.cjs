#!/usr/bin/env node
/** Verify ao-bench.html in a fresh headless Chrome profile.
 * Usage: node scripts/verify-ao.cjs <url> <output.png> [settleMs] [@postFile | expression]
 * Example: node scripts/verify-ao.cjs http://localhost:5173/ao-bench.html /tmp/ao.png 1000 'aoBench.compare()'
 * GPU timings are whole-frame, exclude shader warmup, and are unavailable when
 * EXT_disjoint_timer_query_webgl2 is unsupported. Images are saved alongside output.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ARG = process.argv[2] || 'http://localhost:5173/ao-bench.html';
const OUT = process.argv[3] || 'shot.png';
const SETTLE_MS = Number(process.argv[4] || 1000);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const PORT = Number(process.env.CDP_PORT || (10000 + process.pid % 40000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('devtools endpoint never came up');
}

async function pageTarget() {
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) return page;
    await sleep(150);
  }
  throw new Error('no page target');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || e))); });
    const cdp = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { res, rej } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--enable-unsafe-webgpu',
    '--enable-features=WebGPU',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1400,900',
    URL_ARG,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);

  try {
    await waitForDevtools();
    const target = await pageTarget();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Console.enable');

    // Optional real-editor verification, using a fresh temporary browser profile.
    if (process.env.BENCH_APP === '1') await cdp.eval(`(async()=>{
      const {viewportApi}=await import('/src/ui/viewportApi.ts');
      while(!viewportApi.studio) await new Promise(r=>setTimeout(r,100));
      window.__aoBench={ready:true,error:'',shaderErrors:[]};
    })()`, true);

    // Poll readiness via the page's own telemetry.
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const t = await cdp.eval(`window.__aoBench ? { ready: __aoBench.ready, error: __aoBench.error } : null`).catch(() => null);
      if (t && t.error) throw new Error('page error: ' + t.error);
      if (t && t.ready) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new Error('page never became ready (window.__aoBench.ready)');

    await sleep(SETTLE_MS);

    let POST = process.argv[5];
    if (POST && POST.startsWith('@')) POST = fs.readFileSync(POST.slice(1), 'utf8');
    let postResult;
    if (POST) {
      postResult = await cdp.eval(POST, true);
      fs.writeFileSync(OUT.replace(/\.png$/, '') + '.post.json', JSON.stringify(postResult, null, 2));
      console.log('--- post eval ---');
      console.log(typeof postResult === 'string' ? postResult : JSON.stringify(postResult, null, 2));
    }

    const images = await cdp.eval(`Array.from(document.querySelectorAll('#shots img')).map(img => ({ name: img.alt.split(' ')[0], data: img.src.split(',')[1] }))`);
    for (const img of images) if (img.data) fs.writeFileSync(OUT.replace(/\.png$/, '') + '-' + img.name + '.png', Buffer.from(img.data, 'base64'));
    const telemetry = await cdp.eval(`JSON.parse(JSON.stringify(window.__aoBench))`);
    const shotParams = { format: 'png' };
    if (postResult && postResult.clip) shotParams.clip = postResult.clip;
    const shot = await cdp.send('Page.captureScreenshot', shotParams);
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(OUT.replace(/\.png$/, '') + '.json', JSON.stringify(telemetry, null, 2));

    const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description).join(' '));
    const logErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);

    console.log('--- telemetry ---');
    console.log(JSON.stringify(telemetry, null, 2));
    if (consoleErrors.length) console.log('--- console errors ---\n' + consoleErrors.join('\n'));
    if (logErrors.length) console.log('--- log errors ---\n' + logErrors.join('\n'));
    console.log('screenshot:', OUT);
    if (!telemetry.ready || telemetry.error || telemetry.shaderErrors?.length) process.exitCode = 1;
    cdp.close();
  } catch (e) {
    console.error('FAILED:', e.message);
    if (chromeErr) console.error('chrome stderr tail:\n' + chromeErr.slice(-2000));
    process.exitCode = 1;
  } finally {
    cleanup();
    process.stdout.write('', () => process.exit(process.exitCode || 0));
  }
})();
