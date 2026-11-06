import { brickify, type Built } from '../generate/brickify';
import { Voxels } from '../generate/voxels';
import { ensureIds } from '../plan/ids';
import type { Plan, PlanItem, Step } from '../plan/types';
import { decodeCodes, sampleCodes, ShapeWeights } from './shapeModel';

/**
 * Text → a certified brick model, with our own shape model:
 * prompt → CLIP text embedding → shape model (20×20×20 brick grid) → brickify.
 * Everything runs in the browser from files in public/data/ai (see python/shape).
 */

const BASE = '/data/ai/';
let weights: Promise<ShapeWeights> | null = null;
let clip: Promise<(text: string) => Promise<Float32Array>> | null = null;

export function loadShapeModel(): Promise<ShapeWeights> {
  weights ??= fetch(`${BASE}shape.bin`)
    .then((r) => {
      if (!r.ok) throw new Error('The shape model is not installed (public/data/ai/shape.bin). Train and export it with python/shape/shape.py.');
      return r.arrayBuffer();
    })
    .then(ShapeWeights.parse)
    .catch((e) => { weights = null; throw e; });
  return weights;
}

/** CLIP ViT-B/32 text encoder (the weights the model was trained against), run locally. */
export function loadTextEncoder(): Promise<(text: string) => Promise<Float32Array>> {
  clip ??= (async () => {
    const t = await import('@huggingface/transformers');
    t.env.allowRemoteModels = false;
    t.env.allowLocalModels = true;
    t.env.localModelPath = `${BASE}models/`;
    const id = 'Xenova/clip-vit-base-patch32';
    const tokenizer = await t.AutoTokenizer.from_pretrained(id);
    const model = await t.CLIPTextModelWithProjection.from_pretrained(id, { dtype: 'q8' });
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

/** The colour a prompt names, or one picked by the seed. */
export function colourFor(prompt: string, seed: number): number {
  const p = prompt.toLowerCase();
  for (const [re, c] of COLOURS) if (re.test(p)) return c;
  return DEFAULTS[seed % DEFAULTS.length];
}

/**
 * The model's 20³ grid (x, y across, z up in bricks) → Voxels on the stud grid (y up in
 * plates, 3 per brick), cropped, keeping only the largest connected piece so nothing
 * floats free.
 */
export function gridToVoxels(occ: Uint8Array, colour: number, G = 20): Voxels {
  const at = (x: number, y: number, z: number) => occ[(x * G + y) * G + z] === 1;
  // largest 6-connected piece
  const label = new Int32Array(G * G * G).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const x = Math.floor(c / (G * G)), y = Math.floor(c / G) % G, z = c % G;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= G || Y >= G || Z >= G) continue;
        const j = (X * G + Y) * G + Z;
        if (occ[j] && label[j] < 0) { label[j] = id; stack.push(j); }
      }
    }
    sizes.push(n);
  }
  const keep = sizes.indexOf(Math.max(0, ...sizes));
  let lo = [G, G, G], hi = [-1, -1, -1];
  for (let x = 0; x < G; x++) for (let y = 0; y < G; y++) for (let z = 0; z < G; z++) {
    if (!at(x, y, z) || label[(x * G + y) * G + z] !== keep) continue;
    lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
  }
  if (hi[0] < 0) return new Voxels(1, 1, 1);
  const w = hi[0] - lo[0] + 1, d = hi[1] - lo[1] + 1, bricks = hi[2] - lo[2] + 1;
  return Voxels.from(w, d, bricks * 3, (x, y, z) => {
    const gx = x + lo[0], gy = z + lo[1], gz = Math.floor(y / 3) + lo[2];
    const i = (gx * G + gy) * G + gz;
    return occ[i] && label[i] === keep ? colour : null;
  });
}

export type PromptResult = { prompt: string; seed: number; colour: number; voxels: Voxels; built: Built; plan: Plan };

/** Lay a shape in bricks and make a plan, one step per brick layer. */
export function shapeToPlan(prompt: string, seed: number, voxels: Voxels): { built: Built; plan: Plan } {
  const built = brickify(voxels, { hollow: 1 });
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
    description: `Generated from the prompt “${prompt.trim()}” (seed ${seed}) by BrickMotion's shape model, trained on StableText2Brick (CMU, MIT licence).`,
    steps,
  });
  return { built, plan };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function generateFromPrompt(
  prompt: string,
  seed: number,
  progress?: (stage: string, done: number, total: number) => void,
): Promise<PromptResult> {
  progress?.('Loading the model', 0, 1);
  const [m, encode] = await Promise.all([loadShapeModel(), loadTextEncoder()]);
  progress?.('Reading the prompt', 0, 1);
  const e = await encode(prompt);
  const codes = await sampleCodes(m, e, { random: mulberry32(seed), progress: (d, t) => progress?.('Sketching the shape', d, t) });
  progress?.('Shaping', 1, 1);
  const colour = colourFor(prompt, seed);
  const voxels = gridToVoxels(decodeCodes(m, codes), colour, m.config.G);
  progress?.('Laying bricks', 1, 1);
  return { prompt, seed, colour, voxels, ...shapeToPlan(prompt, seed, voxels) };
}
