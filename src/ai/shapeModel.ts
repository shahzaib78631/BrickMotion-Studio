/**
 * BrickMotion's shape model, run in the browser: a prompt's CLIP embedding → a 20×20×20
 * brick shape. Trained by python/shape/shape.py on StableText2Brick (CMU, MIT licence).
 *
 * A small transformer writes 125 codes bottom-up (5×5×5 latent cells), steered toward
 * the prompt by classifier-free guidance; a 3D VQ-VAE decoder turns the codes into a
 * grid. Both are plain TypeScript over float16 weights (one file with a JSON header),
 * so nothing but the weights has to be downloaded.
 */

export type ShapeConfig = { G: number; L: number; K: number; D: number; W: number; layers: number; heads: number; prefix: number };

type Tensor = { shape: number[]; data: Float32Array };

export class ShapeWeights {
  constructor(readonly config: ShapeConfig, private readonly tensors: Map<string, Tensor>) {}

  get(name: string): Float32Array {
    const t = this.tensors.get(name);
    if (!t) throw new Error(`shape model: missing weights ${name}`);
    return t.data;
  }

  shape(name: string): number[] {
    return this.tensors.get(name)?.shape ?? [];
  }

  /** Read the file python/shape/shape.py `export` writes: u32 header length, JSON, float16 data. */
  static parse(buf: ArrayBuffer): ShapeWeights {
    const view = new DataView(buf);
    const n = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as {
      config: ShapeConfig;
      tensors: Record<string, { shape: number[]; offset: number }>;
    };
    const base = 4 + n;
    const tensors = new Map<string, Tensor>();
    for (const [name, t] of Object.entries(header.tensors)) {
      const size = t.shape.reduce((a, b) => a * b, 1);
      const data = new Float32Array(size);
      for (let i = 0; i < size; i++) data[i] = half(view.getUint16(base + 2 * (t.offset + i), true));
      tensors.set(name, { shape: t.shape, data });
    }
    return new ShapeWeights(header.config, tensors);
  }
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// ------------------------------------------------------------------ small maths

/** y = W x + b, with W stored [out][in]. */
function linear(w: Float32Array, b: Float32Array | null, x: Float32Array, out: number): Float32Array {
  const inn = x.length;
  const y = new Float32Array(out);
  for (let o = 0; o < out; o++) {
    let s = b ? b[o] : 0;
    const row = o * inn;
    for (let i = 0; i < inn; i++) s += w[row + i] * x[i];
    y[o] = s;
  }
  return y;
}

function layerNorm(x: Float32Array, g: Float32Array, b: Float32Array): Float32Array {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length;
  let vr = 0;
  for (const v of x) vr += (v - mean) ** 2;
  const inv = 1 / Math.sqrt(vr / x.length + 1e-5);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = (x[i] - mean) * inv * g[i] + b[i];
  return y;
}

const gelu = (v: number) => 0.5 * v * (1 + Math.tanh(0.7978845608028654 * (v + 0.044715 * v * v * v)));

// ------------------------------------------------------------------ transformer

/** One sequence being written, with its attention cache. */
class Stream {
  readonly keys: Float32Array[];
  readonly values: Float32Array[];
  length = 0;

  constructor(private readonly m: ShapeWeights) {
    const { layers, W, prefix } = m.config;
    const max = prefix + 1 + m.config.L ** 3;
    this.keys = Array.from({ length: layers }, () => new Float32Array(max * W));
    this.values = Array.from({ length: layers }, () => new Float32Array(max * W));
  }

  /** Feed one embedded token; returns the logits for what comes next. */
  step(input: Float32Array): Float32Array {
    const m = this.m;
    const { W, heads, layers, K } = m.config;
    const hd = W / heads;
    const t = this.length++;
    const pos = m.get('gpt.pos');
    let x: Float32Array = new Float32Array(W);
    for (let i = 0; i < W; i++) x[i] = input[i] + pos[t * W + i];
    for (let l = 0; l < layers; l++) {
      const p = `gpt.blocks.${l}.`;
      const h = layerNorm(x, m.get(`${p}ln1.weight`), m.get(`${p}ln1.bias`));
      const qkv = linear(m.get(`${p}qkv.weight`), m.get(`${p}qkv.bias`), h, 3 * W);
      this.keys[l].set(qkv.subarray(W, 2 * W), t * W);
      this.values[l].set(qkv.subarray(2 * W, 3 * W), t * W);
      const att = new Float32Array(W);
      const scores = new Float32Array(t + 1);
      for (let hh = 0; hh < heads; hh++) {
        const o = hh * hd;
        let max = -Infinity;
        for (let s = 0; s <= t; s++) {
          let d = 0;
          for (let i = 0; i < hd; i++) d += qkv[o + i] * this.keys[l][s * W + o + i];
          scores[s] = d / Math.sqrt(hd);
          if (scores[s] > max) max = scores[s];
        }
        let sum = 0;
        for (let s = 0; s <= t; s++) { scores[s] = Math.exp(scores[s] - max); sum += scores[s]; }
        for (let s = 0; s <= t; s++) {
          const a = scores[s] / sum;
          for (let i = 0; i < hd; i++) att[o + i] += a * this.values[l][s * W + o + i];
        }
      }
      const proj = linear(m.get(`${p}proj.weight`), m.get(`${p}proj.bias`), att, W);
      for (let i = 0; i < W; i++) x[i] += proj[i];
      const h2 = layerNorm(x, m.get(`${p}ln2.weight`), m.get(`${p}ln2.bias`));
      const f = linear(m.get(`${p}fc.weight`), m.get(`${p}fc.bias`), h2, 4 * W);
      for (let i = 0; i < f.length; i++) f[i] = gelu(f[i]);
      const o2 = linear(m.get(`${p}out.weight`), m.get(`${p}out.bias`), f, W);
      for (let i = 0; i < W; i++) x[i] += o2[i];
    }
    x = layerNorm(x, m.get('gpt.ln.weight'), m.get('gpt.ln.bias'));
    return linear(m.get('gpt.head.weight'), m.get('gpt.head.bias'), x, K);
  }
}

function tokenEmbedding(m: ShapeWeights, token: number): Float32Array {
  const W = m.config.W;
  return m.get('gpt.tok.weight').slice(token * W, token * W + W);
}

/** Feed the prompt's prefix tokens and BOS; returns the logits for the first code. */
function start(m: ShapeWeights, s: Stream, clip: Float32Array): Float32Array {
  const { W, prefix, K } = m.config;
  const pre = linear(m.get('gpt.cond.weight'), m.get('gpt.cond.bias'), clip, prefix * W);
  for (let i = 0; i < prefix; i++) s.step(pre.subarray(i * W, i * W + W));
  return s.step(tokenEmbedding(m, K));
}

export type SampleOptions = {
  /** how strongly to follow the prompt (1: not boosted) */
  guidance?: number;
  temperature?: number;
  topK?: number;
  random?: () => number;
  /** called after each code, for a progress bar */
  progress?: (done: number, total: number) => void;
};

/** Write the 125 codes for a prompt (unit-length CLIP embedding, 512 numbers). */
export async function sampleCodes(m: ShapeWeights, clip: Float32Array, opts: SampleOptions = {}): Promise<Int32Array> {
  const { guidance = 3, temperature = 0.9, topK = 40, random = Math.random, progress } = opts;
  const total = m.config.L ** 3;
  const cond = new Stream(m);
  const free = new Stream(m);
  let lc = start(m, cond, clip);
  let lf = start(m, free, m.get('gpt.null'));
  const codes = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const l = new Float32Array(lc.length);
    for (let k = 0; k < l.length; k++) l[k] = (lf[k] + guidance * (lc[k] - lf[k])) / temperature;
    const code = pick(l, topK, random);
    codes[i] = code;
    progress?.(i + 1, total);
    if (i + 1 < total) {
      const e = tokenEmbedding(m, code);
      lc = cond.step(e);
      lf = free.step(e);
    }
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  return codes;
}

function pick(logits: Float32Array, topK: number, random: () => number): number {
  const idx = Array.from(logits.keys()).sort((a, b) => logits[b] - logits[a]).slice(0, topK);
  const max = logits[idx[0]];
  const p = idx.map((i) => Math.exp(logits[i] - max));
  let r = random() * p.reduce((a, b) => a + b, 0);
  for (let i = 0; i < idx.length; i++) {
    r -= p[i];
    if (r < 0) return idx[i];
  }
  return idx[idx.length - 1];
}

// ------------------------------------------------------------------ VQ-VAE decoder

/** A 3D feature map: channels, then x, y, z. */
type Grid = { c: number; n: number; data: Float32Array };

function conv(m: ShapeWeights, name: string, x: Grid, relu: boolean): Grid {
  const w = m.get(`${name}.weight`);
  const b = m.get(`${name}.bias`);
  const [out, inn, k] = m.shape(`${name}.weight`);
  const pad = (k - 1) / 2;
  const n = x.n;
  const n3 = n * n * n;
  const y = new Float32Array(out * n3);
  for (let o = 0; o < out; o++) y.fill(b[o], o * n3, (o + 1) * n3);
  for (let o = 0; o < out; o++) {
    const yo = o * n3;
    for (let i = 0; i < inn; i++) {
      const xi = i * n3;
      for (let a = 0; a < k; a++) for (let bb = 0; bb < k; bb++) for (let c = 0; c < k; c++) {
        const wv = w[((o * inn + i) * k + a) * k * k + bb * k + c];
        if (wv === 0) continue;
        const dx = a - pad, dy = bb - pad, dz = c - pad;
        const x0 = Math.max(0, -dx), x1 = Math.min(n, n - dx);
        const y0 = Math.max(0, -dy), y1 = Math.min(n, n - dy);
        const z0 = Math.max(0, -dz), z1 = Math.min(n, n - dz);
        for (let px = x0; px < x1; px++) for (let py = y0; py < y1; py++) {
          const row = yo + (px * n + py) * n;
          const src = xi + ((px + dx) * n + (py + dy)) * n + dz;
          for (let pz = z0; pz < z1; pz++) y[row + pz] += wv * x.data[src + pz];
        }
      }
    }
  }
  if (relu) for (let i = 0; i < y.length; i++) if (y[i] < 0) y[i] = 0;
  return { c: out, n, data: y };
}

/** ConvTranspose3d, kernel 4, stride 2, padding 1: doubles the side. */
function up(m: ShapeWeights, name: string, x: Grid, relu: boolean): Grid {
  const w = m.get(`${name}.weight`);
  const b = m.get(`${name}.bias`);
  const [inn, out, k] = m.shape(`${name}.weight`);
  const n = x.n, N = n * 2, n3 = n * n * n, N3 = N * N * N;
  const y = new Float32Array(out * N3);
  for (let o = 0; o < out; o++) y.fill(b[o], o * N3, (o + 1) * N3);
  for (let i = 0; i < inn; i++) for (let o = 0; o < out; o++) {
    const yo = o * N3, xi = i * n3;
    for (let a = 0; a < k; a++) for (let bb = 0; bb < k; bb++) for (let c = 0; c < k; c++) {
      const wv = w[((i * out + o) * k + a) * k * k + bb * k + c];
      for (let px = 0; px < n; px++) {
        const X = 2 * px - 1 + a;
        if (X < 0 || X >= N) continue;
        for (let py = 0; py < n; py++) {
          const Y = 2 * py - 1 + bb;
          if (Y < 0 || Y >= N) continue;
          const row = yo + (X * N + Y) * N;
          const src = xi + (px * n + py) * n;
          for (let pz = 0; pz < n; pz++) {
            const Z = 2 * pz - 1 + c;
            if (Z >= 0 && Z < N) y[row + Z] += wv * x.data[src + pz];
          }
        }
      }
    }
  }
  if (relu) for (let i = 0; i < y.length; i++) if (y[i] < 0) y[i] = 0;
  return { c: out, n: N, data: y };
}

/**
 * Codes (written bottom-up: z, then y, then x) → occupancy of the 20³ grid, indexed
 * x·400 + y·20 + z (x, y across in studs, z up in bricks).
 */
export function decodeCodes(m: ShapeWeights, codes: Int32Array): Uint8Array {
  const { L, D } = m.config;
  const book = m.get('vq.codes');
  const l3 = L * L * L;
  const lat = new Float32Array(D * l3);
  for (let z = 0; z < L; z++) for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
    const code = codes[z * L * L + y * L + x];
    for (let d = 0; d < D; d++) lat[d * l3 + (x * L + y) * L + z] = book[code * D + d];
  }
  let g: Grid = { c: D, n: L, data: lat };
  g = conv(m, 'vq.dec.0', g, true);
  g = up(m, 'vq.dec.2', g, true);
  g = conv(m, 'vq.dec.4', g, true);
  g = up(m, 'vq.dec.6', g, true);
  g = conv(m, 'vq.dec.8', g, false);
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = g.data[i] > 0 ? 1 : 0;
  return out;
}
