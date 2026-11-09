/** Dev-only: runs the WebGL ShadeNet on a dumped crop and compares it with PyTorch's output (data/neuralshade/nstest). */
import { NeuralShade } from '../render/neuralShade';

const st = document.getElementById('st')!;
const N = 512;

function texture(gl: WebGL2RenderingContext, data: Uint8Array, half = false): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, N, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2));
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}
async function main() {
  const model = new URLSearchParams(location.search).get('model') ?? 'shadenet_probe';
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })!;
  const bytes = async (n: string) => new Uint8Array(await (await fetch(`/data/neuralshade/nstest/${n}.bin`)).arrayBuffer());
  const [frame, albedo, normal, pos, vis, specBuf] = await Promise.all(['frame', 'albedo', 'normal', 'pos', 'vis', 'spec'].map(bytes));
  const expected = new Float32Array(await (await fetch('/data/neuralshade/nstest/expected.f32')).arrayBuffer());
  const net = await NeuralShade.load(gl, `/models/${model}`);
  net.resize(N, N);
  const t0 = performance.now();
  net.run(texture(gl, frame), texture(gl, albedo), texture(gl, normal), texture(gl, pos, true), null, false, texture(gl, vis), texture(gl, specBuf));
  const out = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, out);
  const ms = performance.now() - t0;
  // expected is CHW, top row first; the GL read is bottom row first
  let sum = 0, max = 0, n = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 3; c++) {
    const got = out[((N - 1 - y) * N + x) * 4 + c] / 255;
    const want = expected[(c * N + y) * N + x];
    const d = Math.abs(got - want);
    sum += d; n++; if (d > max) max = d;
  }
  // where does the error sit? by distance from the border and by pixel parity
  const errAt = (x: number, y: number) => { let e = 0; for (let c = 0; c < 3; c++) e += Math.abs(out[((N - 1 - y) * N + x) * 4 + c] / 255 - expected[(c * N + y) * N + x]); return e / 3 * 255; };
  const ring: Record<string, number[]> = { b0_8: [], b8_32: [], b32_128: [], inner: [] };
  const parity = [0, 0, 0, 0], pc = [0, 0, 0, 0];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const e = errAt(x, y), d = Math.min(x, y, N - 1 - x, N - 1 - y);
    ring[d < 8 ? 'b0_8' : d < 32 ? 'b8_32' : d < 128 ? 'b32_128' : 'inner'].push(e);
    parity[(y & 1) * 2 + (x & 1)] += e; pc[(y & 1) * 2 + (x & 1)]++;
  }
  const mean = (a: number[]) => (a.reduce((p, q) => p + q, 0) / Math.max(1, a.length)).toFixed(2);
  const extra = `ring errors: ${Object.entries(ring).map(([k, v]) => `${k}=${mean(v)}`).join(' ')}  parity: ${parity.map((v, i) => (v / pc[i]).toFixed(2)).join(' ')}`;
  st.textContent = `mean |webgl - pytorch| = ${((sum / n) * 255).toFixed(3)} / 255, max ${(max * 255).toFixed(2)} / 255  (${ms.toFixed(0)} ms incl. upload)\n${extra}`;
  (window as unknown as Record<string, unknown>).neuralResult = { mean: (sum / n) * 255, max: max * 255, ms };
}
main().catch((e) => { st.textContent = `ERROR ${e?.stack ?? e}`; });
