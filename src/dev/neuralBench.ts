/** Dev-only: frame time of the WebGL ShadeNet at a given size, 32-bit and 16-bit feature maps. /neural-bench.html?model=shadenet_em&w=1080&h=1920 */
import { NeuralShade } from '../render/neuralShade';

const st = document.getElementById('st')!;
async function main() {
  const q = new URLSearchParams(location.search);
  const model = q.get('model') ?? 'shadenet_em', W = Number(q.get('w') ?? 1080), H = Number(q.get('h') ?? 1920);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })!;
  const tex = (half: boolean) => {
    const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
    if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(W * H * 4).fill(128));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  };
  const inputs = [tex(false), tex(false), tex(false), tex(true)] as const;
  const sync = () => { const b = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); };
  const lines: string[] = [`${model} at ${W}×${H}`];
  for (const half of q.get('ablate') ? [] : [false, true]) {
    const net = await NeuralShade.load(gl, `/models/${model}`, { half });
    net.resize(W, H);
    net.run(...inputs, null); sync(); // warm up: compiles shaders
    const n = 8, t0 = performance.now();
    for (let i = 0; i < n; i++) net.run(...inputs, null);
    sync();
    const ms = (performance.now() - t0) / n;
    if (q.get('profile') && !half) {
      net.profile = new Map();
      for (let i = 0; i < 4; i++) net.run(...inputs, null);
      sync();
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 50)); net.collectProfile(); }
      const total = [...net.profile.values()].reduce((a, b) => a + b, 0);
      lines.push(`per layer (ms per frame, total ${(total / 4).toFixed(1)}): ` + [...net.profile.entries()].map(([k, v]) => `${k} ${(v / 4).toFixed(1)}`).join(', '));
      net.profile = null;
    }
    lines.push(`${half ? '16-bit' : '32-bit'} feature maps: ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(0)} fps)`);
    net.dispose();
  }
  if (q.get('ablate')) {
    const net = await NeuralShade.load(gl, `/models/${model}`, { half: false });
    net.resize(W, H);
    const names = net.stepNames; const read = new Float32Array(4);
    const probe = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, read); };
    let prev = 0; const rows: string[] = [];
    for (let n = 0; n <= net.stepCount; n += 1) {
      net.debugSteps = n; net.run(...inputs, null); probe();
      const reps = 6, t0 = performance.now();
      for (let i = 0; i < reps; i++) { net.run(...inputs, null); }
      probe();
      const ms = (performance.now() - t0) / reps;
      if (n > 0) rows.push(`${names[n - 1]} +${(ms - prev).toFixed(1)}`);
      prev = ms;
    }
    lines.push(`cumulative increments (ms): ${rows.join(', ')}; total ${prev.toFixed(1)}`);
  }
  st.textContent = lines.join('\n');
}
main().catch((e) => { st.textContent = `ERROR ${e?.stack ?? e}`; });
