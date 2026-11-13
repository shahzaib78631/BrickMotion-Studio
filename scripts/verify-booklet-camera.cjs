#!/usr/bin/env node
/**
 * Render and measure known booklet steps through Three.js in headless Chrome.
 * Usage: node scripts/verify-booklet-camera.cjs <url> <output.png>
 * Writes the page screenshot, a JSON report and native-resolution per-step comparisons.
 * Env: CHROME_BIN, CDP_PORT (default 9333).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ARG = process.argv[2] || 'http://localhost:5173/booklet-camera.html';
const OUT = process.argv[3] || 'shot.png';
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
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=2200,1400',
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

    let ready = false;
    for (let i = 0; i < 2400; i++) {
      const t = await cdp.eval(`({done: window.done, error: window.error, status: document.getElementById('st')?.textContent})`);
      if (t.error) throw new Error(t.error);
      if (i % 40 === 0) console.log(t.status);
      if (t.done) { ready = true; break; }
      await sleep(500);
    }
    if (!ready) throw new Error('camera fit timed out');
    let POST = process.argv[4];
    if (POST && POST.startsWith('@')) POST = fs.readFileSync(POST.slice(1), 'utf8');
    let postResult;
    if (POST) {
      postResult = await cdp.eval(POST, true).catch((e) => 'post-eval error: ' + e.message);
      console.log('--- post eval ---');
      console.log(typeof postResult === 'string' ? postResult : JSON.stringify(postResult, null, 2));
    }

    const telemetry = await cdp.eval(`JSON.parse(JSON.stringify(window.joint))`);
    telemetry.sourceUrl = URL_ARG;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT.replace(/\.png$/, '.json'), JSON.stringify(telemetry, null, 2));
    const shotParams = { format: 'png', captureBeyondViewport: true };
    const metrics = await cdp.send('Page.getLayoutMetrics');
    shotParams.clip = {x:0,y:0,width:Math.min(metrics.cssContentSize.width, 2400),height:Math.min(metrics.cssContentSize.height, 16000),scale:1};
    if (postResult && postResult.clip) shotParams.clip = postResult.clip;
    const shot = await cdp.send('Page.captureScreenshot', shotParams);
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

    const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description).join(' '));
    const logErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);

    for (const step of telemetry.steps) {
      const data = await cdp.eval(`(() => {
        const row = document.querySelector('[data-step="${step.step}"]');
        const panels = [...row.querySelectorAll('img,canvas')];
        const out = document.createElement('canvas'); const gap = 16, title = 36;
        const width = panels[0].naturalWidth || panels[0].width, height = panels[0].naturalHeight || panels[0].height;
        out.width = width * 2 + gap * 3;
        out.height = height * 2 + gap * 3 + title * 2;
        const ctx = out.getContext('2d'); ctx.fillStyle = '#171a20'; ctx.fillRect(0,0,out.width,out.height);
        const labels = ['Booklet reference', 'Three.js fitted pose', 'Edge overlay', 'Silhouette difference'];
        panels.forEach((p,k) => { const x = gap + (k%2)*(width+gap), y=gap+Math.floor(k/2)*(height+title+gap); ctx.fillStyle='#e6e9ef';ctx.font='16px system-ui';ctx.fillText(labels[k],x,y+22);ctx.drawImage(p,x,y+title,width,height); });
        return out.toDataURL('image/png').split(',')[1];
      })()`);
      fs.writeFileSync(OUT.replace(/\.png$/, `-step-${step.step}.png`), Buffer.from(data, 'base64'));
    }
    require('./booklet-camera-gallery.cjs')(OUT, telemetry);
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
