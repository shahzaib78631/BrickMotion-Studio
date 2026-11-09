import { importLDraw } from '../io/ldrawImport';
import type { Plan, Step } from '../plan/types';
import { getColors } from '../state/partService';
import { loadTextEncoder, namedColour, withoutColours } from './promptToModel';

/**
 * Text → a real model, remixed: the prompt is matched (CLIP) against every model in the
 * LDraw Official Model Repository that the shape model learned from, the closest one is
 * loaded with its real parts, and recoloured when the prompt names a colour. The models
 * are CC BY: every result names its set and the model's author.
 *
 * Files: public/data/ai/remix_index.{json,bin} (python/omr/remix_index.py) and the models
 * themselves under public/data/omr (python/omr/download_omr.py).
 */

export type RemixSample = {
  set: string;
  name: string;
  theme: string;
  /** the model file, under /data/omr/ */
  file: string;
  /** the submodel the sample is ('' for the whole model) */
  sub: string;
  pieces: number;
  size: [number, number, number];
  author: string;
  /** where the file is: under /data/omr/ (the default) or /data/bricknet/ */
  source?: 'omr' | 'bricknet';
  /** a BrickNet model's description (it has no set name) */
  caption?: string;
};

export type RemixIndex = {
  samples: RemixSample[];
  /** per caption: whose it is, its scale, and its 8-bit embedding */
  textOwner: Int32Array;
  textScale: Float32Array;
  text: Int8Array;
  /** per sample and view: scale and 8-bit embedding of a render */
  views: number;
  imageScale: Float32Array;
  image: Int8Array;
};

const DIM = 512;
const BASE = '/data/ai/';

export function parseRemixIndex(samples: RemixSample[], buf: ArrayBuffer): RemixIndex {
  const head = new Uint32Array(buf, 0, 4);
  const [n, nText, views, dim] = head;
  if (dim !== DIM || n !== samples.length) throw new Error('The remix index does not match its sample list.');
  let o = 16;
  const take = <T>(make: (b: ArrayBuffer, off: number, len: number) => T, len: number, bytes: number): T => {
    const v = make(buf, o, len);
    o += len * bytes;
    return v;
  };
  const textOwner = take((b, off, len) => new Int32Array(b, off, len), nText, 4);
  const textScale = take((b, off, len) => new Float32Array(b, off, len), nText, 4);
  const imageScale = take((b, off, len) => new Float32Array(b, off, len), n * views, 4);
  const text = take((b, off, len) => new Int8Array(b, off, len), nText * DIM, 1);
  const image = take((b, off, len) => new Int8Array(b, off, len), n * views * DIM, 1);
  return { samples, textOwner, textScale, text, views, imageScale, image };
}

/** A file of the index, or null when it is missing (a dev server answers that with its HTML page). */
async function fetchIndexFile(name: string): Promise<Response | null> {
  const r = await fetch(`${BASE}${name}`).catch(() => null);
  return r?.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r : null;
}

/** A BrickNet row carries only what differs per model (python/bricknet/remix_index.py). */
const BRICKNET_ROW: Omit<RemixSample, 'name' | 'file' | 'pieces'> = { set: '', theme: 'BrickNet', sub: '', size: [0, 0, 0], author: '', source: 'bricknet' };

async function loadOne(name: string, defaults?: Partial<RemixSample>): Promise<RemixIndex | null> {
  const [s, b] = await Promise.all([fetchIndexFile(`${name}.json`), fetchIndexFile(`${name}.bin`)]);
  if (!s || !b) return null;
  const rows = (await s.json()) as RemixSample[];
  return parseRemixIndex(defaults ? rows.map((r) => ({ ...defaults, ...r }) as RemixSample) : rows, await b.arrayBuffer());
}

let indexes: Promise<RemixIndex[]> | null = null;

/**
 * Every installed index: the OMR sets (required) and the BrickNet models (python/bricknet,
 * optional: 67k smaller captioned builds, no renders).
 */
export function loadRemixIndexes(): Promise<RemixIndex[]> {
  indexes ??= Promise.all([loadOne('remix_index'), loadOne('bricknet_index', BRICKNET_ROW)]).then(([omr, bricknet]) => {
    if (!omr) throw new Error('The remix index is not installed (public/data/ai/remix_index.json and .bin).');
    return bricknet ? [omr, bricknet] : [omr];
  }).catch((e) => { indexes = null; throw e; });
  return indexes;
}

function dot(v: Int8Array, at: number, scale: number, e: Float32Array): number {
  let s = 0;
  for (let k = 0; k < DIM; k++) s += v[at + k] * e[k];
  return s * scale;
}

function zscores(v: Float32Array): Float32Array {
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let sd = 0;
  for (const x of v) sd += (x - mean) ** 2;
  sd = Math.sqrt(sd / v.length) || 1;
  return v.map((x) => (x - mean) / sd);
}

/** How much a render of a model counts next to its names: the names match more reliably. */
const IMAGE_WEIGHT = 0.3;

/** Best text match per sample: the max over its captions. */
function textScores(ix: RemixIndex, e: Float32Array): Float32Array {
  const text = new Float32Array(ix.samples.length).fill(-1);
  for (let c = 0; c < ix.textOwner.length; c++) {
    const s = dot(ix.text, c * DIM, ix.textScale[c], e);
    const o = ix.textOwner[c];
    if (s > text[o]) text[o] = s;
  }
  return text;
}

/** How much the renders look like the prompt, as z-scores within the index (0 without renders). */
function imageZ(ix: RemixIndex, e: Float32Array): Float32Array {
  const n = ix.samples.length;
  if (!ix.views) return new Float32Array(n);
  const image = new Float32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < ix.views; v++) {
      const at = i * ix.views + v;
      image[i] = Math.max(image[i], dot(ix.image, at * DIM, ix.imageScale[at], e));
    }
  }
  return zscores(image);
}

/**
 * The samples closest to a CLIP text embedding, best first, across every index: by their
 * captions (set name, theme, submodel; a BrickNet model's descriptions), each index scored
 * on its own scale so neither buries the other, helped a little by how much renders look like the prompt.
 */
export function search(ixs: RemixIndex | RemixIndex[], e: Float32Array, k = 8): { sample: RemixSample; index: number; score: number }[] {
  const list = Array.isArray(ixs) ? ixs : [ixs];
  const found: { sample: RemixSample; index: number; score: number }[] = [];
  for (const ix of list) {
    // each index on its own scale: short set names match a prompt more closely than long
    // descriptions do, so one shared scale would bury the described models
    const zt = zscores(textScores(ix, e)), zi = imageZ(ix, e);
    for (let i = 0; i < ix.samples.length; i++) found.push({ sample: ix.samples[i], index: i, score: zt[i] + IMAGE_WEIGHT * zi[i] });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, k);
}

/** The plan seen from one of its submodels: its steps at the top, only what it uses kept. */
export function rootAt(plan: Plan, sub: string): Plan {
  if (!sub) return plan;
  const subs = plan.submodels ?? {};
  const key = Object.keys(subs).find((k) => k.toLowerCase() === sub.toLowerCase());
  if (!key) throw new Error(`The model has no submodel "${sub}".`);
  const used = new Set<string>();
  const visit = (steps: Step[]) => {
    for (const s of steps) for (const p of s.pieces) {
      if ('submodel' in p && !used.has(p.submodel)) { used.add(p.submodel); visit(subs[p.submodel]?.steps ?? []); }
    }
  };
  visit(subs[key].steps);
  const { submodels: _all, ...rest } = plan;
  const kept = Object.fromEntries(Object.entries(subs).filter(([k]) => used.has(k)));
  return { ...rest, steps: subs[key].steps, ...(used.size ? { submodels: kept } : {}) };
}

/** Colours that are a model's trim rather than its body: black, white, greys, tan. */
const TRIM = new Set([0, 7, 8, 15, 19, 71, 72]);

/**
 * The model's body colour (the solid colour on the most pieces, trim aside) swapped for
 * `to` everywhere. Returns the colour that was replaced, or null when nothing changed.
 */
export function recolour(plan: Plan, to: number): number | null {
  const colours = getColors();
  const all = [plan.steps, ...Object.values(plan.submodels ?? {}).map((m) => m.steps)];
  const count = new Map<number, number>();
  for (const steps of all) for (const s of steps) for (const p of s.pieces) {
    if (!('part' in p)) continue;
    const c = Number(p.color);
    const def = colours.get(c);
    if (TRIM.has(c) || (def && def.finish !== 'solid') || c === 16 || c === 24) continue;
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const body = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (body === undefined || body === to) return null;
  for (const steps of all) for (const s of steps) for (const p of s.pieces) {
    if ('part' in p && Number(p.color) === body) p.color = to;
  }
  return body;
}

export type RemixResult = {
  prompt: string;
  seed: number;
  plan: Plan;
  sample: RemixSample;
  /** the other close matches, best first */
  matches: RemixSample[];
  /** the colour the body was changed from (null: kept as built) */
  recoloured: number | null;
};

const PICK_FROM = 5;

/**
 * A remixed real model for a prompt. The seed picks among the closest few matches, so
 * Shuffle walks through them.
 */
export async function remixFromPrompt(
  prompt: string,
  seed: number,
  progress?: (stage: string) => void,
  /** which of the close matches to use (by default the seed picks) */
  choice?: number,
): Promise<RemixResult> {
  progress?.('Loading the index');
  const [ix, encode] = await Promise.all([loadRemixIndexes(), loadTextEncoder()]);
  progress?.('Reading the prompt');
  // colours are applied afterwards, so they should not decide which model is found
  const found = search(ix, await encode(withoutColours(prompt) || prompt), PICK_FROM);
  if (!found.length) throw new Error('No model matched.');
  const pick = found[(choice ?? Math.abs(seed)) % found.length].sample;
  progress?.(`Loading ${pick.name}`);
  const dir = pick.source ?? 'omr';
  const r = await fetch(`/data/${dir}/${pick.file}`);
  if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`The model file is not installed (public/data/${dir}/${pick.file}).`);
  const text = await r.text();
  // a BrickNet file carries its description as a comment (python/bricknet/decode.py)
  const caption = pick.source === 'bricknet' ? /^0 \/\/ (.+)$/m.exec(text)?.[1] : undefined;
  const full = importLDraw(text, pick.file);
  const plan = rootAt(full, pick.sub);
  const to = namedColour(prompt);
  const recoloured = to === null ? null : recolour(plan, to);
  const label = prompt.trim().replace(/^./, (c) => c.toUpperCase()) || 'Remix';
  plan.name = `${label} (from ${pick.name})`;
  plan.description = pick.source === 'bricknet' ? [
    `Remixed from the prompt “${prompt.trim()}”: a model from the BrickNet dataset (Kulits & Schmid, CVPR 2026)`,
    `described as: ${caption ?? pick.name}${recoloured !== null ? ' Recoloured.' : ''}`,
  ].join(', ') : [
    `Remixed from the prompt “${prompt.trim()}”: ${pick.sub ? `the “${pick.sub}” part of ` : ''}LEGO set ${pick.set} “${pick.name}” (${pick.theme}),`,
    `as modelled for the LDraw Official Model Repository${pick.author ? ` by ${pick.author}` : ''} (CC BY 2.0/4.0)${recoloured !== null ? ', recoloured' : ''}.`,
  ].join(' ');
  return { prompt, seed, plan, sample: caption ? { ...pick, caption } : pick, matches: found.map((f) => f.sample), recoloured };
}
