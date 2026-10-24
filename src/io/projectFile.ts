/**
 * A BrickMotion project file (.brickmotion): the model plus the build animation timelines
 * already planned for it, so opening the file plays at once instead of planning again.
 *
 * {
 *   format: 'brickmotion-project', version: 1, savedAt,
 *   plan,                                   // the same plan as a .plan.json
 *   timelines: [{ model, opts, timeline }]  // model '' is the whole set; opts is the options key
 * }
 * Each timeline's matrix table is stored as base64 (little-endian float64).
 */
import { parsePlan } from '../plan/schema';
import type { Plan } from '../plan/types';
import type { EncodedTimeline } from '../anim/timelineData';

export const PROJECT_EXTENSION = 'brickmotion';
export type SavedTimeline = { model: string; opts: string; timeline: EncodedTimeline };
type StoredTimeline = { model: string; opts: string; timeline: Omit<EncodedTimeline, 'mats'> & { mats: string } };
type ProjectJson = { format: 'brickmotion-project'; version: 1; savedAt: string; plan: unknown; timelines: StoredTimeline[] };

function toBase64(values: Float64Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Float64Array {
  const raw = atob(text);
  if (raw.length % 8) throw new Error('matrix table has a partial number');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

export function projectToJson(plan: Plan, timelines: SavedTimeline[]): string {
  const file: ProjectJson = {
    format: 'brickmotion-project',
    version: 1,
    savedAt: new Date().toISOString(),
    plan,
    timelines: timelines.map(({ model, opts, timeline }) => ({ model, opts, timeline: { ...timeline, mats: toBase64(timeline.mats) } })),
  };
  return JSON.stringify(file);
}

export const isProjectFile = (fileName: string) => fileName.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`);

/** Reads a project file. A damaged timeline is skipped (it is planned again); a damaged plan fails. */
export function readProjectFile(text: string): { ok: true; plan: Plan; timelines: SavedTimeline[]; skipped: number } | { ok: false; errors: string[] } {
  let json: Partial<ProjectJson>;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (json?.format !== 'brickmotion-project') return { ok: false, errors: ['This is not a BrickMotion project file.'] };
  if (json.version !== 1) return { ok: false, errors: [`Project file version ${String(json.version)} is newer than this app understands.`] };
  const parsed = parsePlan(json.plan);
  if (!parsed.ok) return parsed;
  const timelines: SavedTimeline[] = [];
  let skipped = 0;
  for (const t of Array.isArray(json.timelines) ? json.timelines : []) {
    try {
      if (typeof t.model !== 'string' || typeof t.opts !== 'string' || typeof t.timeline?.mats !== 'string' || !Array.isArray(t.timeline.tracks) || !Array.isArray(t.timeline.units)) throw new Error('bad shape');
      // Older 'certified' V2 clips were checked with outdated connector and
      // swept-contact logic. Never silently reuse an obsolete safety claim:
      // replan after loading instead. Standard visual clips remain compatible.
      if (t.timeline.construction && (t.timeline.certificationVersion ?? 0) < 2) throw new Error('old collision certificate');
      const mats = fromBase64(t.timeline.mats);
      const count = mats.length / 16;
      const validRef = (i: number) => Number.isInteger(i) && i >= 0 && i < count;
      const refsOk = t.timeline.tracks.every(([, tr]) =>
        [tr.floor, tr.final].every(validRef) && tr.moves.every((m) =>
          [m.from, m.to, ...(m.posePath ?? []), ...(m.rigidDeltas ?? []),
            ...(m.rigidBase === undefined ? [] : [m.rigidBase])].every(validRef) &&
          (m.rigidDeltas === undefined || (m.rigidDeltas.length >= 2 &&
            m.rigidBase !== undefined && m.rigidPivot?.length === 3 && m.rigidPivot.every(Number.isFinite)))));
      if (!refsOk || !mats.every(Number.isFinite)) throw new Error('bad matrices');
      timelines.push({ model: t.model, opts: t.opts, timeline: { ...t.timeline, mats } });
    } catch {
      skipped++;
    }
  }
  return { ok: true, plan: parsed.plan, timelines, skipped };
}
