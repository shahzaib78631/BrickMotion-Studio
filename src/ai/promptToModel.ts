import { brickify, type Built } from '../generate/brickify';
import { Voxels } from '../generate/voxels';
import { ensureIds } from '../plan/ids';
import type { Plan, PlanItem, Step } from '../plan/types';
import { gridSpec, type ShapeConfig } from './shapeModel';

/**
 * Text → a certified brick model, with our own shape model:
 * prompt → CLIP text embedding → shape model (in a worker) → coloured voxels → brickify.
 * Everything runs in the browser from files in public/data/ai (see python/shape): the
 * detailed colour model (shape2.bin) when it is installed, else the first one (shape.bin).
 */

const BASE = '/data/ai/';
let clip: Promise<(text: string) => Promise<Float32Array>> | null = null;
let modelUrl: Promise<string> | null = null;

/** The best installed shape model. */
export function shapeModelUrl(): Promise<string> {
  modelUrl ??= (async () => {
    for (const f of ['shape2.bin', 'shape.bin']) {
      const r = await fetch(`${BASE}${f}`, { method: 'HEAD' }).catch(() => null);
      // a dev server answers a missing file with its HTML page, so check the type too
      if (r?.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) return `${BASE}${f}`;
    }
    throw new Error('No shape model is installed in public/data/ai. Train and export one with python/shape.');
  })().catch((e) => { modelUrl = null; throw e; });
  return modelUrl;
}

let worker: Worker | null = null;
let nextId = 0;

/** Run the shape model in a worker: CLIP embedding → class grid and the model's config. */
function runShapeModel(url: string, e: Float32Array, seed: number, progress?: (done: number, total: number) => void): Promise<{ grid: Uint8Array; config: ShapeConfig }> {
  worker ??= new Worker(new URL('./shapeWorker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const on = (ev: MessageEvent) => {
      const d = ev.data as { id: number; progress?: [number, number]; grid?: Uint8Array; config?: ShapeConfig; error?: string };
      if (d.id !== id) return;
      if (d.progress) return progress?.(...d.progress);
      w.removeEventListener('message', on);
      if (d.error || !d.grid || !d.config) reject(new Error(d.error ?? 'The shape model failed.'));
      else resolve({ grid: d.grid, config: d.config });
    };
    w.addEventListener('message', on);
    w.postMessage({ id, url, clip: e, seed });
  });
}

/** CLIP ViT-B/32 text encoder, run locally in half precision: it matches the PyTorch embeddings the model was trained on (cosine 1.000; the 8-bit file drifts to 0.87–0.94). */
export function loadTextEncoder(): Promise<(text: string) => Promise<Float32Array>> {
  clip ??= (async () => {
    const t = await import('@huggingface/transformers');
    t.env.allowRemoteModels = false;
    t.env.allowLocalModels = true;
    t.env.localModelPath = `${BASE}models/`;
    const id = 'Xenova/clip-vit-base-patch32';
    const tokenizer = await t.AutoTokenizer.from_pretrained(id);
    const model = await t.CLIPTextModelWithProjection.from_pretrained(id, { dtype: 'fp16' });
    return async (text: string) => {
      const inputs = tokenizer([text], { padding: true, truncation: true });
      const { text_embeds } = (await model(inputs)) as { text_embeds: { data: Float32Array } };
      const e = Float32Array.from(text_embeds.data);
      const n = Math.hypot(...e);
      return e.map((v) => v / n);
    };
  })().catch((e) => { clip = null; throw e; });
  return clip;
}

const COLOURS: [RegExp, number][] = [
  [/\bdark red\b|\bmaroon\b|\bburgundy\b/, 320],
  [/\bdark blue\b|\bnavy\b/, 272],
  [/\bdark (gr[ae]y|bluish gr[ae]y)\b|\bcharcoal\b/, 72],
  [/\bdark green\b|\bforest\b/, 288],
  [/\blime\b/, 27],
  [/\bred\b/, 4],
  [/\bblue\b/, 1],
  [/\byellow\b/, 14],
  [/\bgreen\b/, 2],
  [/\bblack\b/, 0],
  [/\bwhite\b|\bsnow\b/, 15],
  [/\bgr[ae]y\b|\bsilver\b|\bstone\b|\bmetal\b/, 71],
  [/\bbrown\b|\bwood(en)?\b/, 70],
  [/\btan\b|\bbeige\b|\bsand\b/, 19],
  [/\borange\b/, 25],
  [/\bpink\b/, 29],
  [/\bpurple\b|\bviolet\b/, 22],
  [/\bgold(en)?\b/, 297],
];
const DEFAULTS = [4, 1, 14, 2, 25, 15, 71, 70, 19, 272];

/** The colour a prompt names, if it names one. */
export function namedColour(prompt: string): number | null {
  const p = prompt.toLowerCase();
  for (const [re, c] of COLOURS) if (re.test(p)) return c;
  return null;
}

/** The prompt without its colour words ("a red police car" → "a police car"). */
export function withoutColours(prompt: string): string {
  let p = prompt;
  for (const [re] of COLOURS) p = p.replace(new RegExp(re.source, 'gi'), ' ');
  return p.replace(/\s+/g, ' ').trim();
}

/** The colour a prompt names, or one picked by the seed. */
export function colourFor(prompt: string, seed: number): number {
  return namedColour(prompt) ?? DEFAULTS[seed % DEFAULTS.length];
}

/**
 * A model's class grid (A × B across, C up, cells indexed (a·B + b)·C + c) → Voxels on the
 * stud grid (y up in plates), cropped, keeping only the largest connected piece so nothing
 * floats free. `plates` is how many plates one cell is tall (v1: a brick, 3; v2: 1);
 * `colourOf` turns a class into an LDraw colour.
 */
export function gridToVoxels(
  grid: Uint8Array,
  dims: { A: number; B: number; C: number },
  plates: number,
  colourOf: (cls: number) => number,
): Voxels {
  const { A, B, C } = dims;
  const index = (a: number, b: number, c: number) => (a * B + b) * C + c;
  // largest 6-connected piece
  const label = new Int32Array(grid.length).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const k = stack.pop()!;
      n++;
      const a = Math.floor(k / (B * C)), b = Math.floor(k / C) % B, c = k % C;
      for (const [da, db, dc] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const x = a + da, y = b + db, z = c + dc;
        if (x < 0 || y < 0 || z < 0 || x >= A || y >= B || z >= C) continue;
        const j = index(x, y, z);
        if (grid[j] && label[j] < 0) { label[j] = id; stack.push(j); }
      }
    }
    sizes.push(n);
  }
  const keep = sizes.indexOf(Math.max(0, ...sizes));
  let lo = [A, B, C], hi = [-1, -1, -1];
  for (let a = 0; a < A; a++) for (let b = 0; b < B; b++) for (let c = 0; c < C; c++) {
    if (label[index(a, b, c)] !== keep || !grid[index(a, b, c)]) continue;
    lo = [Math.min(lo[0], a), Math.min(lo[1], b), Math.min(lo[2], c)];
    hi = [Math.max(hi[0], a), Math.max(hi[1], b), Math.max(hi[2], c)];
  }
  if (hi[0] < 0) return new Voxels(1, 1, 1);
  const w = hi[0] - lo[0] + 1, d = hi[1] - lo[1] + 1, h = hi[2] - lo[2] + 1;
  return Voxels.from(w, d, h * plates, (x, y, z) => {
    const i = index(x + lo[0], z + lo[1], Math.floor(y / plates) + lo[2]);
    return grid[i] && label[i] === keep ? colourOf(grid[i]) : null;
  });
}

export type PromptResult = { prompt: string; seed: number; colour: number; voxels: Voxels; built: Built; plan: Plan };

/** Lay a shape in bricks and make a plan, one step per brick layer. */
export function shapeToPlan(prompt: string, seed: number, voxels: Voxels): { built: Built; plan: Plan } {
  const built = brickify(voxels, { hollow: 1, keepLargest: true });
  const layers = new Map<number, PlanItem[]>();
  for (const it of built.items) {
    const layer = Math.floor(('y' in it ? it.y : 0) / 3);
    layers.set(layer, [...(layers.get(layer) ?? []), it]);
  }
  const steps: Step[] = [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([l, pieces]) => ({ title: `Layer ${l + 1}`, pieces }));
  const name = prompt.trim().replace(/^./, (c) => c.toUpperCase()) || 'Generated model';
  const plan = ensureIds({
    format: 'brickmotion-plan', version: 1,
    name: `${name} #${seed}`,
    description: `Generated from the prompt “${prompt.trim()}” (seed ${seed}) by BrickMotion's shape model, trained on StableText2Brick (CMU, MIT licence) and the LDraw Official Model Repository (CC BY 2.0/4.0, models by their OMR authors).`,
    steps,
  });
  return { built, plan };
}

export async function generateFromPrompt(
  prompt: string,
  seed: number,
  progress?: (stage: string, done: number, total: number) => void,
): Promise<PromptResult> {
  progress?.('Loading the model', 0, 1);
  const [url, encode] = await Promise.all([shapeModelUrl(), loadTextEncoder()]);
  progress?.('Reading the prompt', 0, 1);
  const e = await encode(prompt);
  const { grid, config } = await runShapeModel(url, e, seed, (d, t) => progress?.('Sketching the shape', d, t));
  progress?.('Laying bricks', 1, 1);
  const named = colourFor(prompt, seed);
  const spec = gridSpec(config);
  const palette = config.colours ?? [];
  // v2 cells carry a colour class (the last one is "other"); v1 cells only say filled
  const colourOf = (cls: number) => (cls >= 1 && cls <= palette.length ? palette[cls - 1] : named);
  const voxels = gridToVoxels(grid, spec, config.version === 2 ? 1 : 3, colourOf);
  return { prompt, seed, colour: named, voxels, ...shapeToPlan(prompt, seed, voxels) };
}
