import type { Box } from '../ldraw/flatten';
import type { Assembly } from '../model/assemble';
import type { Warning } from '../model/validate';
import type { Timeline } from '../anim/timeline';
import { modelSteps } from './ops';
import { isSub, type AssemblySpot, type Plan } from './types';

/** 1 stud = 20 LDU, the unit the plan stores spot positions in. */
export const STUD = 20;

/** A chosen floor spot: the main model, or one submodel use. */
export type SpotRef = { model: string; id: string };
export const MAIN_SPOT: SpotRef = { model: '', id: '' };
export const isMainSpot = (r: SpotRef): boolean => r.model === '' && r.id === '';
export const sameSpot = (a: SpotRef | null, b: SpotRef | null): boolean => !!a && !!b && a.model === b.model && a.id === b.id;

/** One row of the Assembly panel: the main model, then every submodel use in build order. */
export type SpotUse = {
  ref: SpotRef;
  /** the model this use lives in ('' = the main model) */
  parent: string;
  /** the submodel it builds ('' for the main model) */
  submodel: string;
  /** its instance-key prefix in the whole set ('' for the main model) */
  path: string;
  /** human name, e.g. "Main model" or "police car – underside 1" */
  label: string;
  /** nesting depth, for indentation */
  depth: number;
};

const parentLabel = (plan: Plan, model: string) => (model === '' ? plan.name || 'Main model' : model);

/**
 * The main model first, then every submodel use in build order (nested uses
 * indented). `floorShift`'s rule: one spot per SubItem, so a use defined inside a
 * submodel appears once and applies to every copy of that submodel.
 */
export function submodelUses(plan: Plan): SpotUse[] {
  const out: SpotUse[] = [{ ref: { model: '', id: '' }, parent: '', submodel: '', path: '', label: 'Main model', depth: 0 }];
  const seen = new Set<string>(['']);
  const walk = (model: string, depth: number, prefix: string) => {
    for (const step of modelSteps(plan, model))
      for (const item of step.pieces) {
        if (!isSub(item) || !item.id) continue;
        const path = prefix ? `${prefix}/${item.id}` : item.id;
        out.push({ ref: { model, id: item.id }, parent: model, submodel: item.submodel, path, label: `${parentLabel(plan, model)} – ${item.submodel}`, depth });
        if (plan.submodels?.[item.submodel] && !seen.has(item.submodel)) {
          seen.add(item.submodel);
          walk(item.submodel, depth + 1, path);
        }
      }
  };
  walk('', 1, '');
  return out;
}

/** The chosen spot of a use, or null for Auto. */
export function spotOf(plan: Plan, use: SpotUse): AssemblySpot | null {
  if (isMainSpot(use.ref)) return plan.assemblySpot ?? null;
  const found = modelSteps(plan, use.ref.model).flatMap((s) => s.pieces).find((i) => i.id === use.ref.id);
  return found && isSub(found) ? found.assembly?.buildSpot ?? null : null;
}

/** The chosen spot of a reference, or null for Auto / unknown. */
export function spotOfRef(plan: Plan, ref: SpotRef): AssemblySpot | null {
  const use = submodelUses(plan).find((u) => sameSpot(u.ref, ref));
  return use ? spotOf(plan, use) : null;
}

/** The floor position the automatic layout gives this use, from the latest planned timeline. */
export function autoCentre(tl: Timeline | null, use: SpotUse): [number, number] | null {
  if (!tl) return null;
  if (isMainSpot(use.ref)) return centre2(tl.modelBox);
  const sub = tl.subBuilds.find((s) => s.key === use.path);
  return sub ? centre2(sub.focus) : null;
}

export const centre2 = (b: Box): [number, number] => [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];

/** The assembled bounding box of one use, in the whole set's own frame. */
export function useBox(asm: Assembly, path: string): Box | null {
  let box: Box | null = null;
  for (const inst of asm.instances) {
    if (path && inst.key !== path && !inst.key.startsWith(`${path}/`)) continue;
    const b = inst.worldBox;
    box = box
      ? { min: [Math.min(box.min[0], b.min[0]), Math.min(box.min[1], b.min[1]), Math.min(box.min[2], b.min[2])], max: [Math.max(box.max[0], b.max[0]), Math.max(box.max[1], b.max[1]), Math.max(box.max[2], b.max[2])] }
      : { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] };
  }
  return box;
}

/** A yaw of `deg` about the vertical axis (the same direction as the piece rotation). */
export function yawMatrix(deg: number): Float64Array {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // column-major, like THREE.Matrix4: set(c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1)
  return new Float64Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

const applyYaw = (m: Float64Array, v: [number, number, number]): [number, number, number] => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

/** Swing a model's footprint about the vertical axis, then move its centre onto the spot (studs). */
export function spotBox(box: Box, spot: AssemblySpot): Box {
  const [cx, cz] = centre2(box);
  const r = yawMatrix(spot.angle);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const p = applyYaw(r, [x - cx, y, z - cz]);
        const q: [number, number, number] = [p[0] + spot.x * STUD, p[1], p[2] + spot.z * STUD];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], q[k]);
          max[k] = Math.max(max[k], q[k]);
        }
      }
  return { min, max };
}

/** Where a build area is on the floor: its own box, its centre (LDU), its facing and whether the user placed it. */
export type SpotMarkerData = { ref: SpotRef; label: string; raw: Box; centre: [number, number]; angle: number; placed: boolean };

/**
 * One entry per build area on the floor, from the assembled set and the latest timeline.
 * Placed spots use their own position; Auto spots use the position the planner gave them
 * (so they are only known once a timeline exists).
 */
export function markers(plan: Plan, asm: Assembly, tl: Timeline | null, uses = submodelUses(plan)): SpotMarkerData[] {
  const out: SpotMarkerData[] = [];
  for (const use of uses) {
    const raw = useBox(asm, use.path);
    if (!raw) continue;
    const spot = spotOf(plan, use);
    if (spot) out.push({ ref: use.ref, label: use.label, raw, centre: [spot.x * STUD, spot.z * STUD], angle: spot.angle, placed: true });
    else {
      const auto = autoCentre(tl, use);
      if (auto) out.push({ ref: use.ref, label: use.label, raw, centre: auto, angle: 0, placed: false });
    }
  }
  return out;
}

/** A use that can be compared with the others: its box, where it is, and whether it is placed. */
export type SpotFootprint = { ref: SpotRef; label: string; box: Box; placed: boolean };

/** The build areas as boxes, for the static overlap check (a placed spot's box is turned by its angle). */
export function footprints(plan: Plan, asm: Assembly, tl: Timeline | null): SpotFootprint[] {
  return markers(plan, asm, tl).map((m) => ({
    ref: m.ref,
    label: m.label,
    box: m.placed ? spotBox(m.raw, { x: m.centre[0] / STUD, z: m.centre[1] / STUD, angle: m.angle }) : boxAt(m.raw, m.centre[0], m.centre[1]),
    placed: m.placed,
  }));
}

/** The four footprint corners of a box swung about the vertical axis, with its centre at (x, z) LDU. */
export function outline(box: Box, x: number, z: number, angle: number): [number, number][] {
  const [cx, cz] = centre2(box);
  const r = yawMatrix(angle);
  return ([[box.min[0], box.min[2]], [box.max[0], box.min[2]], [box.max[0], box.max[2]], [box.min[0], box.max[2]]] as [number, number][]).map(([px, pz]) => {
    const p = applyYaw(r, [px - cx, 0, pz - cz]);
    return [p[0] + x, p[2] + z] as [number, number];
  });
}

/** The plan-space `(x, z)` unit direction a model at `angle` faces. */
export function facing(angle: number): [number, number] {
  const p = applyYaw(yawMatrix(angle), [0, 0, 1]);
  return [p[0], p[2]];
}

/** The box moved so its footprint centre sits at (x, z) LDU. */
function boxAt(box: Box, x: number, z: number): Box {
  const [cx, cz] = centre2(box);
  return {
    min: [box.min[0] + x - cx, box.min[1], box.min[2] + z - cz],
    max: [box.max[0] + x - cx, box.max[1], box.max[2] + z - cz],
  };
}

/** Two build areas overlap when they interpenetrate on all three axes. */
export function boxesOverlap(a: Box, b: Box, margin = 0.5): boolean {
  return [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > margin);
}

export type SpotConflict = { ref: SpotRef; other: SpotRef; message: string };

/**
 * Statically, from bounding boxes: which placed or automatic build areas overlap.
 * Decision: the video still plans with the spot as given; this only reports it.
 */
export function overlaps(areas: SpotFootprint[]): SpotConflict[] {
  const out: SpotConflict[] = [];
  for (let i = 0; i < areas.length; i++)
    for (let j = i + 1; j < areas.length; j++)
      if (boxesOverlap(areas[i].box, areas[j].box))
        out.push({ ref: areas[i].ref, other: areas[j].ref, message: `${areas[i].label} overlaps ${areas[j].label}` });
  return out;
}

/**
 * The assembly-spot Checks entries: build areas that overlap, computed on the main
 * thread from bounding boxes. The video still plans with the spot as given.
 */
export function spotWarnings(plan: Plan, asm: Assembly, tl: Timeline | null): Warning[] {
  const uses = submodelUses(plan);
  const byRef = new Map(uses.map((u) => [`${u.ref.model}\u0000${u.ref.id}`, u] as const));
  return overlaps(footprints(plan, asm, tl)).map((c) => {
    const use = byRef.get(`${c.ref.model}\u0000${c.ref.id}`);
    const main = !use || isMainSpot(use.ref);
    return {
      kind: 'assembly-spot' as const,
      itemIds: main ? [] : [use!.ref.id],
      instanceKeys: [],
      model: use?.ref.model ?? c.ref.model,
      message: `${c.message}. The model is still built there; move one of the spots.`,
    };
  });
}

/** "X 12 · Z −4 studs · 90°", or null for Auto. */
export function formatSpot(spot: AssemblySpot | null | undefined): string | null {
  if (!spot) return null;
  const n = (v: number) => String(Math.round(v * 100) / 100).replace('-', '−');
  const angle = `${n(((spot.angle % 360) + 360) % 360)}°`;
  const axis = (label: string, v: number) => `${label} ${n(v)}`;
  return `${axis('X', spot.x)} · ${axis('Z', spot.z)} studs · ${angle}`;
}
