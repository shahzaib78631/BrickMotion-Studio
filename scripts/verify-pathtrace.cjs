#!/usr/bin/env node
/**
 * Headless WebGPU path-trace verifier for the dev page `pathtrace.html`.
 *
 * Launches headless Chrome with WebGPU enabled, drives it over CDP, waits on the page's
 * `window.__pathTrace` telemetry, optionally runs a post-eval expression, captures a
 * screenshot (optionally clipped to the render canvas) and prints the telemetry. No
 * dependencies — Node's global `WebSocket` + `fetch` (Node 22+).
 *
 * Usage:
 *   node scripts/verify-pathtrace.cjs <url> <out.png> [settleMs] [@postFile | expr]
 *
 * Examples:
 *   # Calibration scene beside its EyeSight reference, capture the whole page:
 *   node scripts/verify-pathtrace.cjs "http://localhost:5173/pathtrace.html?profile=source" out.png 20000
 *
 *   # Click "Measure reference difference" and print the RMSE it reports (runs in-frame):
 *   node scripts/verify-pathtrace.cjs "http://localhost:5173/pathtrace.html?project=1&profile=source" out.png 20000 \
 *     '(async () => { document.getElementById("measure-reference").click(); await new Promise(r => setTimeout(r, 1000)); return document.getElementById("comparison")?.textContent; })()'
 *
 *   # Capture just the render canvas (a WebGPU canvas reads back empty via drawImage outside
 *   # an animation frame, so the CDP clip is the reliable signal):
 *   node scripts/verify-pathtrace.cjs "<url>" canvas.png 18000 \
 *     '@scripts/verify-pathtrace/clip.js'
 *
 * Env: CHROME_BIN (chrome path), CDP_PORT (default 9333 — set a different one to run in parallel).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ARG = process.argv[2] || 'http://localhost:5173/pathtrace.html';
const OUT = process.argv[3] || 'shot.png';
const SETTLE_MS = Number(process.argv[4] || 20000);
const PORT = Number(process.env.CDP_PORT || 9333);

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

    // WebGPU adapter availability, before trusting any page state.
    const gpu = await cdp.eval(`(async () => {
      if (!navigator.gpu) return 'no navigator.gpu';
      const a = await navigator.gpu.requestAdapter();
      if (!a) return 'no adapter';
      return 'adapter ok';
    })()`, true).catch((e) => 'eval error: ' + e.message);
    console.log('WebGPU:', gpu);
    if (gpu === 'no navigator.gpu' || gpu === 'no adapter') throw new Error('WebGPU unavailable in headless Chrome: ' + gpu);

    // Poll readiness via the page's own telemetry.
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const t = await cdp.eval(`window.__pathTrace ? { ready: __pathTrace.ready, error: __pathTrace.error } : null`).catch(() => null);
      if (t && t.error) throw new Error('page error: ' + t.error);
      if (t && t.ready) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new Error('page never became ready (window.__pathTrace.ready)');

    await sleep(SETTLE_MS);

    let POST = process.argv[5];
    if (POST && POST.startsWith('@')) POST = fs.readFileSync(POST.slice(1), 'utf8');
    let postResult;
    if (POST) {
      postResult = await cdp.eval(POST, true).catch((e) => 'post-eval error: ' + e.message);
      console.log('--- post eval ---');
      console.log(typeof postResult === 'string' ? postResult : JSON.stringify(postResult, null, 2));
    }

    const telemetry = await cdp.eval(`JSON.parse(JSON.stringify(window.__pathTrace))`);
    const shotParams = { format: 'png' };
    if (postResult && postResult.clip) shotParams.clip = postResult.clip;
    const shot = await cdp.send('Page.captureScreenshot', shotParams);
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

    const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description).join(' '));
    const logErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);

    console.log('--- telemetry ---');
    console.log(JSON.stringify(telemetry, null, 2));
    if (consoleErrors.length) console.log('--- console errors ---\n' + consoleErrors.join('\n'));
    if (logErrors.length) console.log('--- log errors ---\n' + logErrors.join('\n'));
    console.log('screenshot:', OUT);
    cdp.close();
  } catch (e) {
    console.error('FAILED:', e.message);
    if (chromeErr) console.error('chrome stderr tail:\n' + chromeErr.slice(-2000));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
