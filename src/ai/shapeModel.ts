/**
 * BrickMotion's shape model, run in the browser: a prompt's CLIP embedding → a shape.
 * Trained by python/shape (v1: shape.py on StableText2Brick, a 20³ brick grid, filled or
 * not; v2: shape2.py on the OMR's sets and StableText2Brick, 32×32 studs × 64 plates, in
 * colour).
 *
 * A small transformer writes the codes bottom-up (one per patch of the grid), steered
 * toward the prompt by classifier-free guidance; a patch-transformer VQ-VAE decoder turns
 * the codes into the grid. Both are plain TypeScript over float16 weights (one file with
 * a JSON header), so nothing but the weights has to be downloaded.
 */

export type ShapeConfig = {
  K: number; D: number; W: number; layers: number; heads: number; prefix: number;
  VW: number; vqLayers: number; vqHeads: number;
  /** v1: a cube of side G in patches of side G/L */
  G?: number; L?: number;
  /** v2: X × Z studs × Y plates, in patches of PX × PZ × PY */
  version?: number; X?: number; Z?: number; Y?: number; PX?: number; PZ?: number; PY?: number;
  /** v2: decoder classes (0 empty, 1…n colours, n+1 other) and the LDraw colour of each */
  classes?: number; colours?: number[];
};

/** The grid either version writes: A × B across, C up, cells indexed (a·B + b)·C + c. */
export type GridSpec = { A: number; B: number; C: number; PA: number; PB: number; PC: number; seq: number; classes: number };

export function gridSpec(c: ShapeConfig): GridSpec {
  if (c.version === 2) {
    const [A, B, C, PA, PB, PC] = [c.X!, c.Z!, c.Y!, c.PX!, c.PZ!, c.PY!];
    return { A, B, C, PA, PB, PC, seq: (A / PA) * (B / PB) * (C / PC), classes: c.classes! };
  }
  const P = c.G! / c.L!;
  return { A: c.G!, B: c.G!, C: c.G!, PA: P, PB: P, PC: P, seq: c.L! ** 3, classes: 2 };
}

type Tensor = { shape: number[]; data: Float32Array };

export class ShapeWeights {
  readonly grid: GridSpec;

  constructor(readonly config: ShapeConfig, private readonly tensors: Map<string, Tensor>) {
    this.grid = gridSpec(config);
  }

  get(name: string): Float32Array {
    const t = this.tensors.get(name);
    if (!t) throw new Error(`shape model: missing weights ${name}`);
    return t.data;
  }

  shape(name: string): number[] {
    return this.tensors.get(name)?.shape ?? [];
  }

  /** Read the file python/shape `export` writes: u32 header length, JSON, float16 data. */
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

/** y_i = W x_i + b for each input, with W stored [out][in]; one pass over W for all inputs. */
function linearN(w: Float32Array, b: Float32Array | null, xs: Float32Array[], out: number): Float32Array[] {
  const inn = xs[0].length;
  const ys = xs.map(() => new Float32Array(out));
  for (let o = 0; o < out; o++) {
    const row = o * inn;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      let s = b ? b[o] : 0;
      for (let i = 0; i < inn; i++) s += w[row + i] * x[i];
      ys[k][o] = s;
    }
  }
  return ys;
}

function linear(w: Float32Array, b: Float32Array | null, x: Float32Array, out: number): Float32Array {
  return linearN(w, b, [x], out)[0];
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

/** Causal attention of the newest position over a cache. */
function attend(q: Float32Array, keys: Float32Array, values: Float32Array, t: number, W: number, heads: number): Float32Array {
  const hd = W / heads;
  const att = new Float32Array(W);
  const scores = new Float32Array(t + 1);
  for (let h = 0; h < heads; h++) {
    const o = h * hd;
    let max = -Infinity;
    for (let s = 0; s <= t; s++) {
      let d = 0;
      for (let i = 0; i < hd; i++) d += q[o + i] * keys[s * W + o + i];
      scores[s] = d / Math.sqrt(hd);
      if (scores[s] > max) max = scores[s];
    }
    let sum = 0;
    for (let s = 0; s <= t; s++) { scores[s] = Math.exp(scores[s] - max); sum += scores[s]; }
    for (let s = 0; s <= t; s++) {
      const a = scores[s] / sum;
      for (let i = 0; i < hd; i++) att[o + i] += a * values[s * W + o + i];
    }
  }
  return att;
}

// ------------------------------------------------------------------ transformer

/** Several sequences written side by side (the prompt and no prompt), each with its cache. */
class Streams {
  readonly keys: Float32Array[][];
  readonly values: Float32Array[][];
  length = 0;

  constructor(private readonly m: ShapeWeights, readonly count: number) {
    const { layers, W, prefix } = m.config;
    const max = prefix + 1 + m.grid.seq;
    this.keys = Array.from({ length: count }, () => Array.from({ length: layers }, () => new Float32Array(max * W)));
    this.values = Array.from({ length: count }, () => Array.from({ length: layers }, () => new Float32Array(max * W)));
  }

  /** Feed one embedded token to each stream; returns each stream's logits for what comes next. */
  step(inputs: Float32Array[]): Float32Array[] {
    const m = this.m;
    const { W, heads, layers, K } = m.config;
    const t = this.length++;
    const pos = m.get('gpt.pos');
    let xs: Float32Array[] = inputs.map((input) => {
      const x = new Float32Array(W);
      for (let i = 0; i < W; i++) x[i] = input[i] + pos[t * W + i];
      return x;
    });
    for (let l = 0; l < layers; l++) {
      const p = `gpt.blocks.${l}.`;
      const qkv = linearN(m.get(`${p}qkv.weight`), m.get(`${p}qkv.bias`), xs.map((x) => layerNorm(x, m.get(`${p}ln1.weight`), m.get(`${p}ln1.bias`))), 3 * W);
      const atts = qkv.map((q, k) => {
        this.keys[k][l].set(q.subarray(W, 2 * W), t * W);
        this.values[k][l].set(q.subarray(2 * W, 3 * W), t * W);
        return attend(q, this.keys[k][l], this.values[k][l], t, W, heads);
      });
      const proj = linearN(m.get(`${p}proj.weight`), m.get(`${p}proj.bias`), atts, W);
      xs.forEach((x, k) => { for (let i = 0; i < W; i++) x[i] += proj[k][i]; });
      const f = linearN(m.get(`${p}fc.weight`), m.get(`${p}fc.bias`), xs.map((x) => layerNorm(x, m.get(`${p}ln2.weight`), m.get(`${p}ln2.bias`))), 4 * W);
      for (const v of f) for (let i = 0; i < v.length; i++) v[i] = gelu(v[i]);
      const o = linearN(m.get(`${p}out.weight`), m.get(`${p}out.bias`), f, W);
      xs.forEach((x, k) => { for (let i = 0; i < W; i++) x[i] += o[k][i]; });
    }
    xs = xs.map((x) => layerNorm(x, m.get('gpt.ln.weight'), m.get('gpt.ln.bias')));
    return linearN(m.get('gpt.head.weight'), m.get('gpt.head.bias'), xs, K);
  }
}

function tokenEmbedding(m: ShapeWeights, token: number): Float32Array {
  const W = m.config.W;
  return m.get('gpt.tok.weight').slice(token * W, token * W + W);
}

/** Feed each stream's prompt prefix and BOS; returns the logits for the first code. */
function start(m: ShapeWeights, s: Streams, clips: Float32Array[]): Float32Array[] {
  const { W, prefix, K } = m.config;
  const pre = linearN(m.get('gpt.cond.weight'), m.get('gpt.cond.bias'), clips, prefix * W);
  for (let i = 0; i < prefix; i++) s.step(pre.map((p) => p.subarray(i * W, i * W + W)));
  return s.step(clips.map(() => tokenEmbedding(m, K)));
}

/** The logits at each position for given codes (what PyTorch's forward gives; for tests). */
export function conditionalLogits(m: ShapeWeights, clip: Float32Array, codes: number[]): Float32Array[] {
  const s = new Streams(m, 1);
  const out = [start(m, s, [clip])[0]];
  for (const c of codes) out.push(s.step([tokenEmbedding(m, c)])[0]);
  return out;
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

/** Write the codes for a prompt (unit-length CLIP embedding, 512 numbers). */
export async function sampleCodes(m: ShapeWeights, clip: Float32Array, opts: SampleOptions = {}): Promise<Int32Array> {
  const { guidance = 3, temperature = 0.9, topK = 40, random = Math.random, progress } = opts;
  const total = m.grid.seq;
  const s = new Streams(m, 2);
  let [lc, lf] = start(m, s, [clip, m.get('gpt.null')]);
  const codes = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const l = new Float32Array(lc.length);
    for (let k = 0; k < l.length; k++) l[k] = (lf[k] + guidance * (lc[k] - lf[k])) / temperature;
    const code = pick(l, topK, random);
    codes[i] = code;
    progress?.(i + 1, total);
    if (i + 1 < total) {
      const e = tokenEmbedding(m, code);
      [lc, lf] = s.step([e, e]);
    }
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // let other work run
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

/** An open (not causal) transformer block over a whole sequence, in place. */
function block(m: ShapeWeights, p: string, xs: Float32Array[], heads: number): void {
  const T = xs.length, W = xs[0].length, hd = W / heads;
  const qkv = linearN(m.get(`${p}qkv.weight`), m.get(`${p}qkv.bias`), xs.map((x) => layerNorm(x, m.get(`${p}ln1.weight`), m.get(`${p}ln1.bias`))), 3 * W);
  const scores = new Float32Array(T);
  const atts = xs.map((_, t) => {
    const att = new Float32Array(W);
    for (let h = 0; h < heads; h++) {
      const o = h * hd;
      let max = -Infinity;
      for (let s = 0; s < T; s++) {
        let d = 0;
        for (let i = 0; i < hd; i++) d += qkv[t][o + i] * qkv[s][W + o + i];
        scores[s] = d / Math.sqrt(hd);
        if (scores[s] > max) max = scores[s];
      }
      let sum = 0;
      for (let s = 0; s < T; s++) { scores[s] = Math.exp(scores[s] - max); sum += scores[s]; }
      for (let s = 0; s < T; s++) {
        const a = scores[s] / sum;
        for (let i = 0; i < hd; i++) att[o + i] += a * qkv[s][2 * W + o + i];
      }
    }
    return att;
  });
  const proj = linearN(m.get(`${p}proj.weight`), m.get(`${p}proj.bias`), atts, W);
  xs.forEach((x, t) => { for (let i = 0; i < W; i++) x[i] += proj[t][i]; });
  const f = linearN(m.get(`${p}fc.weight`), m.get(`${p}fc.bias`), xs.map((x) => layerNorm(x, m.get(`${p}ln2.weight`), m.get(`${p}ln2.bias`))), 4 * W);
  for (const v of f) for (let i = 0; i < v.length; i++) v[i] = gelu(v[i]);
  const o = linearN(m.get(`${p}out.weight`), m.get(`${p}out.bias`), f, W);
  xs.forEach((x, t) => { for (let i = 0; i < W; i++) x[i] += o[t][i]; });
}

/**
 * Codes (one per patch, written bottom-up: up, then the second axis, then the first) →
 * the class of every cell, indexed (a·B + b)·C + c: 0 empty, else filled (v1: 1; v2: the
 * colour class, see `config.colours`).
 */
export function decodeCodes(m: ShapeWeights, codes: Int32Array): Uint8Array {
  const { D, VW, vqLayers, vqHeads } = m.config;
  const { A, B, C, PA, PB, PC, classes } = m.grid;
  const LA = A / PA, LB = B / PB;
  const cells = PA * PB * PC;
  const book = m.get('vq.codes');
  const pos = m.get('vq.dec_pos');
  const xs = linearN(m.get('vq.dec_in.weight'), m.get('vq.dec_in.bias'), Array.from(codes, (code) => book.subarray(code * D, code * D + D)), VW);
  xs.forEach((h, t) => { for (let i = 0; i < VW; i++) h[i] += pos[t * VW + i]; });
  for (let l = 0; l < vqLayers; l++) block(m, `vq.dec_blocks.${l}.`, xs, vqHeads);
  const outs = linearN(
    m.get('vq.dec_out.weight'), m.get('vq.dec_out.bias'),
    xs.map((x) => layerNorm(x, m.get('vq.dec_ln.weight'), m.get('vq.dec_ln.bias'))),
    classes === 2 ? cells : cells * classes,
  );
  const grid = new Uint8Array(A * B * C);
  outs.forEach((logits, t) => {
    const pc = Math.floor(t / (LA * LB)), pb = Math.floor(t / LA) % LB, pa = t % LA;
    for (let ia = 0; ia < PA; ia++) for (let ib = 0; ib < PB; ib++) for (let ic = 0; ic < PC; ic++) {
      const cell = (ia * PB + ib) * PC + ic;
      let cls: number;
      if (classes === 2) cls = logits[cell] > 0 ? 1 : 0;
      else {
        cls = 0;
        for (let k = 1; k < classes; k++) if (logits[cell * classes + k] > logits[cell * classes + cls]) cls = k;
      }
      if (cls) grid[((pa * PA + ia) * B + (pb * PB + ib)) * C + pc * PC + ic] = cls;
    }
  });
  return grid;
}
