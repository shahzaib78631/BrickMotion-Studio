import { exportLDraw } from '../io/ldrawExport';
import { getColors, metricsOf } from '../state/partService';
import { standalonePlan } from './modelFiles';
import { modelSteps } from './ops';
import type { CorrectorMark, Plan, Step, StepMeta } from './types';

/**
 * The Assembly Corrector is the LDraw step planner in `assembly-corrector/ldraw_autostep.py`.
 * A browser cannot run Python, so the dev server runs it (see
 * `scripts/assembly-corrector-bridge.mjs`) and this module talks to that bridge: it sends
 * the model as an LDraw document, gets the corrected document plus its diagnosis back, and
 * maps the corrected step grouping onto the project's own items.
 *
 * When the bridge is absent (the built site, or a server without the engine) every call
 * reports `ready: false` and nothing is changed — the correction is never guessed at.
 */

const ENDPOINT = '/api/assembly-corrector';
/** The engine writes `1 ...` placement lines; a step boundary is `0 STEP`. */
const PLACEMENT = /^1\s+\S+\s+.*\s+\S+\.(dat|ldr)$/i;

export type CorrectorHealth = {
  ready: boolean;
  python?: string;
  script?: string;
  ldraw?: string;
  version?: string;
  offline?: boolean;
  message: string;
};

export type CorrectorSummary = {
  units: number;
  steps: number;
  floating: number;
  unsupported: number;
  missingGeometry: number;
  dropped: number;
  snapLinks: number;
  fallbackLinks: number;
  issues: string[];
};

export type CorrectorRun = {
  ok: boolean;
  code: number;
  message?: string;
  mpd: string | null;
  diagnosis: unknown;
  summary: CorrectorSummary | null;
  log: string;
};

/** Which models follow the corrector, and how to put one back. */

const withEngine = (message: string): CorrectorHealth => ({ ready: false, message });

export async function correctorHealth(): Promise<CorrectorHealth> {
  try {
    const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) return withEngine(`the assembly corrector bridge answered ${response.status}`);
    const body = (await response.json()) as Partial<CorrectorHealth>;
    return { ready: body.ready === true, message: body.message ?? 'no status', ...body };
  } catch {
    return withEngine('the assembly corrector needs the local dev server (`npm run dev`) to run Python');
  }
}

/** One model as an LDraw document, exactly as the engine should see it. */
export function modelMpd(plan: Plan, model: string): string {
  return exportLDraw(standalonePlan(plan, model), metricsOf, getColors());
}

/** The model's own items in the order the export writes them (steps, then piece order). */
export function exportedIds(plan: Plan, model: string): (string | undefined)[] {
  return modelSteps(plan, model).flatMap((step) => step.pieces.map((piece) => piece.id));
}

export async function runCorrector(mpd: string, name: string, opts: { maxStep?: number } = {}): Promise<CorrectorRun> {
  const failed = (message: string, code = -1): CorrectorRun => ({ ok: false, code, message, mpd: null, diagnosis: null, summary: null, log: '' });
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mpd, name, maxStep: opts.maxStep }),
    });
    if (!response.ok) return failed(`the assembly corrector bridge answered ${response.status}`);
    const body = (await response.json()) as { ok?: boolean; code?: number; message?: string; mpd?: string | null; diagnosis?: string | null; stdout?: string; stderr?: string };
    const diagnosis = body.diagnosis ? safeJson(body.diagnosis) : null;
    const summary = summariseDiagnosis(diagnosis);
    const log = [body.stdout, body.stderr].filter(Boolean).join('\n').trim();
    if (!body.mpd) return { ...failed(body.message ?? 'the engine wrote no model', body.code ?? -1), diagnosis, summary, log };
    return { ok: body.ok === true, code: body.code ?? 0, message: body.message, mpd: body.mpd, diagnosis, summary, log };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The first entry of the engine's diagnosis list, as a flat summary. */
export function summariseDiagnosis(diagnosis: unknown): CorrectorSummary | null {
  const entry = (Array.isArray(diagnosis) ? diagnosis[0] : diagnosis) as Record<string, unknown> | null | undefined;
  if (!entry || typeof entry !== 'object') return null;
  const count = (key: string) => {
    const value = entry[key];
    if (Array.isArray(value)) return value.length;
    return Number.isFinite(value) ? Number(value) : 0;
  };
  const issues = Array.isArray(entry.issues) ? entry.issues : [];
  return {
    units: count('units'),
    steps: count('steps'),
    floating: count('floating'),
    unsupported: count('unsupported'),
    missingGeometry: count('missing_geometry'),
    dropped: count('dropped'),
    snapLinks: count('snap_links'),
    fallbackLinks: count('fallback_links'),
    issues: issues.map((issue) => {
      const one = issue as Record<string, unknown>;
      const code = String(one.code ?? one.kind ?? 'issue');
      const detail = one.message ?? one.detail ?? one.suggestion;
      return typeof detail === 'string' && detail ? `${code}: ${detail}` : code;
    }).slice(0, 8),
  };
}

/** `0 FILE` block boundaries: the main model is the first block of our export. */
function blocks(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^0\s+FILE\s+/i.test(line)) {
      current = [];
      out.push(current);
      continue;
    }
    if (current) current.push(line);
    if (/^0\s+NOFILE\b/i.test(line)) current = null;
  }
  return out;
}

/**
 * The corrected step grouping as our item ids: the engine preserves every placement line
 * character-for-character and may reorder them, so identical lines are matched in order,
 * then by part name, and anything still unmatched is left where the model has it.
 */
export function groupsFromCorrectedMpd(corrected: string, sent: string, ids: (string | undefined)[]): { groups: string[][]; unmatched: number } {
  const sentLines = (blocks(sent)[0] ?? []).filter((line) => PLACEMENT.test(line));
  if (sentLines.length !== ids.length) return { groups: [], unmatched: ids.length };
  const queue = new Map<string, string[]>();
  sentLines.forEach((line, index) => {
    const id = ids[index];
    if (!id) return;
    const list = queue.get(line);
    if (list) list.push(id);
    else queue.set(line, [id]);
  });
  const partOf = new Map<string, string[]>();
  sentLines.forEach((line, index) => {
    const id = ids[index];
    const part = id ? line.split(/\s+/).pop()!.toLowerCase() : '';
    if (!id || !part) return;
    const list = partOf.get(part);
    if (list) list.push(id);
    else partOf.set(part, [id]);
  });
  const groups: string[][] = [];
  let unmatched = 0;
  let current: string[] = [];
  for (const line of (blocks(corrected)[0] ?? [])) {
    if (/^0\s+STEP\b/i.test(line)) {
      if (current.length) groups.push(current);
      current = [];
      continue;
    }
    if (!PLACEMENT.test(line)) continue;
    const id = queue.get(line)?.shift() ?? partOf.get(line.split(/\s+/).pop()!.toLowerCase())?.shift();
    if (id) current.push(id);
    else unmatched++;
  }
  if (current.length) groups.push(current);
  return { groups, unmatched };
}

const metaOf = (steps: Step[]): StepMeta[] => steps.map(({ title, notes, pauseAfter }) => ({ title, notes, pauseAfter }));

/** Remember the order a model is in now, so the correction can be undone later. */
export function correctorMark(plan: Plan, model: string, summary: CorrectorSummary | null): CorrectorMark {
  const steps = modelSteps(plan, model);
  return {
    at: Date.now(),
    steps: steps.length,
    units: summary?.units,
    issues: summary?.issues.length,
    previous: { ids: steps.map((step) => step.pieces.map((piece) => piece.id)), meta: metaOf(steps) },
  };
}

/** The plan with the model's steps rewritten to the corrected grouping. */
export function withCorrectorSteps(plan: Plan, model: string, groups: string[][]): Plan {
  const steps = modelSteps(plan, model);
  const items = new Map<string, (typeof steps)[number]['pieces'][number]>();
  for (const step of steps) for (const piece of step.pieces) if (piece.id) items.set(piece.id, piece);
  const meta = metaOf(steps);
  const next: Step[] = groups.map((group, index) => ({
    ...(meta[index] ?? {}),
    pieces: group.map((id) => items.get(id)).filter((piece): piece is NonNullable<typeof piece> => !!piece),
  }));
  // Never drop a piece the grouping did not mention: keep it on the last step.
  const placed = new Set(next.flatMap((step) => step.pieces));
  const left = steps.flatMap((step) => step.pieces).filter((piece) => !placed.has(piece));
  if (left.length) {
    if (next.length) next[next.length - 1].pieces.push(...left);
    else next.push({ pieces: left });
  }
  return replaceSteps(plan, model, next.filter((step) => step.pieces.length));
}

/** The inverse: put the remembered grouping back. */
export function withoutCorrectorSteps(plan: Plan, model: string, mark: CorrectorMark): Plan | null {
  if (!mark.previous) return null;
  const current = modelSteps(plan, model);
  const items = new Map<string, (typeof current)[number]['pieces'][number]>();
  for (const step of current) for (const piece of step.pieces) if (piece.id) items.set(piece.id, piece);
  const restored: Step[] = mark.previous.ids.map((ids, index) => ({
    ...(mark.previous!.meta[index] ?? {}),
    pieces: ids.map((id) => (id ? items.get(id) : undefined)).filter((piece): piece is NonNullable<typeof piece> => !!piece),
  }));
  const placed = new Set(restored.flatMap((step) => step.pieces));
  const left = current.flatMap((step) => step.pieces).filter((piece) => !placed.has(piece));
  if (left.length) restored[restored.length - 1]?.pieces.push(...left);
  return replaceSteps(plan, model, restored.filter((step) => step.pieces.length));
}

function replaceSteps(plan: Plan, model: string, steps: Step[]): Plan {
  if (!model) return { ...plan, steps };
  const current = plan.submodels?.[model];
  if (!current) return plan;
  return { ...plan, submodels: { ...plan.submodels, [model]: { ...current, steps } } };
}
