import { importLDraw } from '../io/ldrawImport';
import type { Plan } from '../plan/types';

/**
 * Client for BrickMotion Studio's local BrickGen v3 / BrickLayer-Agent dev-server bridge
 * (scripts/brickgen-bridge.ts). Generates certified `.ldr` models from text prompts,
 * reference images, or external 3D meshes (.obj/.stl/.ply) and loads them directly as a `Plan`.
 */

const URL = '/api/brickgen';

export type BrickGenShowcaseItem = { id: string; title: string };

export type BrickGenStatus = {
  ready: boolean;
  hasV3: boolean;
  hasDpo: boolean;
  hasBlueprint: boolean;
  hasBmshot: boolean;
  showcase: BrickGenShowcaseItem[];
};

export type BrickGenStats = {
  pieces: number;
  overlaps: number;
  groups: number;
  stands: boolean;
  clip?: number;
  imgSim?: number;
  bpIou?: number;
  seconds?: number;
  source?: string;
};

export type BrickGenResult = {
  plan: Plan;
  ldr: string;
  stats: BrickGenStats;
  renderDataUrl?: string;
  blueprintDataUrl?: string;
};

export type BrickGenRequest = {
  mode: 'neural' | 'agent' | 'showcase';
  prompt?: string;
  showcaseId?: string;
  imageDataUrl?: string;
  imageWeight?: number;
  meshText?: string;
  meshExt?: string;
  meshSpanStuds?: number;
  samples?: number;
  maxParts?: number;
  useBlueprint?: boolean;
  useDpo?: boolean;
  seed?: number;
  rounds?: number;
  signal?: AbortSignal;
};

let statusPromise: Promise<BrickGenStatus | null> | null = null;

export function brickgenStatus(): Promise<BrickGenStatus | null> {
  statusPromise ??= fetch(URL)
    .then(async (r) => {
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) return null;
      return (await r.json()) as BrickGenStatus;
    })
    .catch(() => null);
  return statusPromise;
}

export async function generateWithBrickGen(req: BrickGenRequest): Promise<BrickGenResult> {
  const { signal, ...payload } = req;
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: string;
    title?: string;
    ldr?: string;
    stats?: BrickGenStats;
    renderDataUrl?: string;
    blueprintDataUrl?: string;
  };
  if (!r.ok || !body.ok || !body.ldr) {
    throw new Error(body.message || `BrickGen bridge returned ${r.status}`);
  }
  const title = body.title || req.prompt?.trim() || 'BrickGen Model';
  const plan = importLDraw(body.ldr, `${title.replace(/[^a-z0-9_-]+/gi, '_')}.ldr`);
  plan.name = title;
  return {
    plan,
    ldr: body.ldr,
    stats: body.stats ?? { pieces: 0, overlaps: 0, groups: 1, stands: true },
    renderDataUrl: body.renderDataUrl,
    blueprintDataUrl: body.blueprintDataUrl,
  };
}
