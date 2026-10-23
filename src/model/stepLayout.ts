import * as THREE from 'three';
import { layoutFloor, type FloorItem } from '../anim/floorLayout';
import type { Box } from '../ldraw/flatten';
import { poseAt, type Timeline } from '../anim/timeline';
import { unionBox, type Assembly, type Instance } from './assemble';

/**
 * How the Build view shows the step being edited:
 * - separated: the step's new parts wait on the floor in front of the model (as staged in the video)
 * - exploded: the new parts float just above where they go
 * - assembled: everything in place
 */
export type StepView = 'separated' | 'exploded' | 'assembled';

const STUD = 20;
const GAP = 2; // studs between the model and the laid-out parts

/** Top-level item id → its instances (a submodel item has many). */
function groupsOf(asm: Assembly): Map<string, Instance[]> {
  const out = new Map<string, Instance[]>();
  for (const inst of asm.instances) {
    const top = inst.key.split('/')[0];
    let list = out.get(top);
    if (!list) out.set(top, (list = []));
    list.push(inst);
  }
  return out;
}

const boxOf = (list: Instance[]) => list.reduce<Box | null>((b, i) => unionBox(b, i.worldBox), null);

/**
 * World (LDU) matrices for the instances of `step`'s items under the chosen view; the
 * rest of the model stays where it is. Parts keep their orientation so they read like
 * an instruction booklet's parts callout. Returns an empty map when nothing moves.
 */
export function stepPoses(asm: Assembly, step: number, view: StepView): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>();
  if (view === 'assembled' || !asm.bounds) return out;
  const groups = groupsOf(asm);
  const fresh = asm.nodes.filter((n) => n.step === step);
  if (!fresh.length) return out;
  const before = asm.nodes.filter((n) => n.step < step).flatMap((n) => groups.get(n.itemId) ?? []);
  const freshBox = fresh.map((n) => boxOf(groups.get(n.itemId) ?? [])).reduce<Box | null>((b, x) => (x ? unionBox(b, x) : b), null);
  if (!freshBox) return out;
  // what is already built (or, on the first step, where the step's parts go)
  const ref = boxOf(before) ?? freshBox;
  const ground = asm.bounds.max[1];

  const move = (list: Instance[], dx: number, dy: number, dz: number) => {
    const t = new THREE.Matrix4().makeTranslation(dx, dy, dz);
    for (const inst of list) out.set(inst.key, t.clone().multiply(inst.world));
  };

  if (view === 'exploded') {
    const height = ref.max[1] - Math.min(ref.min[1], freshBox.min[1]);
    const lift = Math.max(72, Math.min(240, height * 0.6)); // LDU, up is −Y
    for (const n of fresh) move(groups.get(n.itemId) ?? [], 0, -lift, 0);
    return out;
  }

  const items: (FloorItem & { box: Box; list: Instance[] })[] = [];
  fresh.forEach((n, k) => {
    const list = groups.get(n.itemId) ?? [];
    const box = boxOf(list);
    if (!box) return;
    items.push({
      id: n.itemId,
      w: Math.max(1, Math.ceil((box.max[0] - box.min[0]) / STUD - 0.01)),
      d: Math.max(1, Math.ceil((box.max[2] - box.min[2]) / STUD - 0.01)),
      group: k, // keep the arrival order: first part on the left
      box,
      list,
    });
  });
  const x0 = Math.floor(ref.min[0] / STUD);
  const width = Math.max(16, Math.ceil((ref.max[0] - ref.min[0]) / STUD));
  const { pos } = layoutFloor(
    items.map(({ id, w, d }) => ({ id, w, d, group: 0 })),
    { x0, z0: 0, width, depth: 1e6 },
  );
  // rows grow away from the model, towards the camera (LDraw −Z)
  const front = Math.floor(ref.min[2] / STUD) - GAP;
  for (const it of items) {
    const p = pos.get(it.id);
    if (!p) continue;
    const zMin = (front - p.z - it.d) * STUD;
    move(it.list, p.x * STUD - it.box.min[0], ground - it.box.max[1], zMin - it.box.min[2]);
  }
  return out;
}

/** Bounds of the instances under the given poses (for framing and the floor). */
export function posedBounds(list: Instance[], poses: Map<string, THREE.Matrix4>, metricsBody: (part: string) => Box): Box | null {
  let b: Box | null = null;
  const tmp = new THREE.Box3();
  for (const inst of list) {
    const m = poses.get(inst.key);
    if (!m) {
      b = unionBox(b, inst.worldBox);
      continue;
    }
    const body = metricsBody(inst.part);
    tmp.set(new THREE.Vector3(...body.min), new THREE.Vector3(...body.max)).applyMatrix4(m);
    b = unionBox(b, { min: [tmp.min.x, tmp.min.y, tmp.min.z], max: [tmp.max.x, tmp.max.y, tmp.max.z] });
  }
  return b;
}

const SAME_SPOT = 0.5; // LDU

/**
 * Where the step's parts wait when it starts in the planned build animation (the same
 * collision-safe build as the Preview), for the Build view's Separated layout. Null when the timeline doesn't match the model (still planning
 * after an edit), so callers fall back to the simple layout.
 */
export function timelineStep(asm: Assembly, step: number, tl: Timeline): { poses: Map<string, THREE.Matrix4> } | null {
  const spans = tl.steps.filter((s) => s.model === '' && s.index === step);
  if (!spans.length) return null;
  const start = Math.min(...spans.map((s) => s.start));
  const groups = groupsOf(asm);
  const fresh = asm.nodes.filter((n) => n.step === step).flatMap((n) => groups.get(n.itemId) ?? []);
  if (!fresh.length) return null;
  for (const inst of fresh) {
    const tr = tl.tracks.get(inst.key);
    if (!tr) return null;
    const a = tr.final.elements, b = inst.world.elements;
    if (Math.abs(a[12] - b[12]) > SAME_SPOT || Math.abs(a[13] - b[13]) > SAME_SPOT || Math.abs(a[14] - b[14]) > SAME_SPOT) return null;
  }
  // Until a part's first flight it rests on its floor spot. (The video drops parts
  // onto the floor as they appear; the Build view shows them already landed.)
  const sample = (t: number) => {
    const at = poseAt(tl, t);
    const out = new Map<string, THREE.Matrix4>();
    for (const inst of fresh) {
      const tr = tl.tracks.get(inst.key)!;
      const first = tr.moves.length ? tl.units[tr.moves[0].unit].start : Infinity;
      out.set(inst.key, t < first ? tr.floor : (at(inst.key) ?? inst.world));
    }
    return out;
  };
  return { poses: sample(start) };
}
