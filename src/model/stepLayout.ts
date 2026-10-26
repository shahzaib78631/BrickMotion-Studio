import * as THREE from 'three';
import { layoutFloor, type FloorItem } from '../anim/floorLayout';
import type { Box } from '../ldraw/flatten';
import { poseAt, type Timeline } from '../anim/timeline';
import { transformBox, unionBox, type Assembly, type Instance, type Metrics } from './assemble';

/**
 * How the Build view shows the step being edited:
 * - separated: the step's new parts wait on the floor in front of the model (as staged in the video)
 * - laidout: every single piece of the step (submodels taken apart) in tidy rows on the floor, by colour
 * - exploded: the new parts float just above where they go
 * - assembled: everything in place
 */
export type StepView = 'separated' | 'laidout' | 'exploded' | 'assembled';

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
 * rest of the model stays where it is. Separated and exploded keep each part's pose;
 * the laid-out views stand every piece up in its own orientation instead, so a part
 * that is bolted on its side in the model still reads like an instruction callout.
 * Returns an empty map when nothing moves.
 */
export function stepPoses(asm: Assembly, step: number | 'all', view: StepView, metrics: Metrics): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>();
  if (view === 'assembled' || !asm.bounds) return out;
  const groups = groupsOf(asm);
  // 'all': the whole model's pieces, laid out where the model stands
  const fresh = asm.nodes.filter((n) => step === 'all' || n.step === step);
  if (!fresh.length) return out;
  const before = step === 'all' ? [] : asm.nodes.filter((n) => n.step < step).flatMap((n) => groups.get(n.itemId) ?? []);
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

  const items: (FloorItem & { box: Box; list: Instance[]; flat: boolean })[] = [];
  const add = (id: string, list: Instance[], group: number, box: Box | null = boxOf(list), flat = false) => {
    if (!box) return;
    items.push({
      id,
      w: Math.max(1, Math.ceil((box.max[0] - box.min[0]) / STUD - 0.01)),
      d: Math.max(1, Math.ceil((box.max[2] - box.min[2]) / STUD - 0.01)),
      group,
      box,
      list,
      flat,
    });
  };
  if (view === 'laidout') {
    // Every piece on its own, like a parts callout: one colour after another. The box
    // is the part's own (unrotated) body, so the cell fits the piece as you see it and
    // the row spacing does not depend on how it happens to be angled in the model.
    const colours = new Map<string, number>();
    for (const inst of fresh.flatMap((n) => groups.get(n.itemId) ?? [])) {
      const c = String(inst.color);
      if (!colours.has(c)) colours.set(c, colours.size);
      add(inst.key, [inst], colours.get(c)!, metrics(inst.part).body, true);
    }
  } else {
    fresh.forEach((n) => add(n.itemId, groups.get(n.itemId) ?? [], 0)); // arrival order: first part on the left
  }
  const x0 = Math.floor(ref.min[0] / STUD);
  // wide enough that many loose pieces still make a tidy block rather than a long strip
  const area = items.reduce((a, it) => a + (it.w + 1) * (it.d + 1), 0);
  const width = Math.max(16, Math.ceil((ref.max[0] - ref.min[0]) / STUD), view === 'laidout' ? Math.ceil(Math.sqrt(area) * 1.6) : 0);
  const { pos } = layoutFloor(
    items.map(({ id, w, d, group }) => ({ id, w, d, group })),
    { x0, z0: 0, width, depth: 1e6 },
  );
  // rows grow away from the model, towards the camera (LDraw −Z)
  const front = Math.floor(ref.min[2] / STUD) - GAP;
  for (const it of items) {
    const p = pos.get(it.id);
    if (!p) continue;
    const zMin = (front - p.z - it.d) * STUD;
    const dx = p.x * STUD - it.box.min[0];
    const dy = ground - it.box.max[1];
    const dz = zMin - it.box.min[2];
    // A staged piece drops the rotation it carries in the model and sits flat on the
    // floor, resting on its own body: resting the AABB of a tilted part on the ground
    // leaves it standing on an edge, which reads as a floating, mis-rotated piece.
    if (it.flat) for (const inst of it.list) out.set(inst.key, new THREE.Matrix4().makeTranslation(dx, dy, dz));
    else move(it.list, dx, dy, dz);
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
  // Each piece shows where it waits just before its LAST flight: a loose part on its
  // floor spot, a submodel complete at its build spot, a wheel assembled on the staging
  // table. (Its first-flight floor spot alone would overlap: a submodel's pieces wait
  // there one batch after another, reusing spots, never all at once.)
  const at = new Map<number, (key: string) => THREE.Matrix4 | null>();
  const poseAtTime = (t: number) => {
    let f = at.get(t);
    if (!f) at.set(t, (f = poseAt(tl, t)));
    return f;
  };
  const poses = new Map<string, THREE.Matrix4>();
  for (const inst of fresh) {
    const tr = tl.tracks.get(inst.key)!;
    if (tr.moves.length <= 1) {
      poses.set(inst.key, tr.floor);
      continue;
    }
    const t = Math.max(start, tl.units[tr.moves[tr.moves.length - 1].unit].start);
    poses.set(inst.key, poseAtTime(t)(inst.key) ?? tr.floor);
  }
  spreadBuilt(asm, step, groups, poses);
  return { poses };
}

const overlapXZ = (a: Box, b: Box) => a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[2] < b.max[2] && b.min[2] < a.max[2];

/**
 * Submodels are built one after another on the same spot beside the model, so shown
 * together just before each is attached they would sit inside one another (10156's
 * minifig inside its truck). Each built group that overlaps what is already placed
 * slides further out along +X, a stud clear of it. Loose parts keep their floor spots.
 */
function spreadBuilt(asm: Assembly, step: number, groups: Map<string, Instance[]>, poses: Map<string, THREE.Matrix4>): void {
  const boxOf = (insts: Instance[]) => {
    let b: Box | null = null;
    for (const i of insts) {
      const pose = poses.get(i.key);
      if (pose) b = unionBox(b, transformBox(i.worldBox, pose.clone().multiply(i.world.clone().invert())));
    }
    return b;
  };
  const items = asm.nodes.filter((n) => n.step === step).map((n) => groups.get(n.itemId) ?? []).filter((g) => g.length);
  const built = items.filter((g) => g.length > 1);
  const placed: Box[] = items.filter((g) => g.length === 1).map(boxOf).filter((b): b is Box => !!b);
  for (const g of built) {
    const b = boxOf(g);
    if (!b) continue;
    let dx = 0;
    for (let guard = 0; guard < 64; guard++) {
      const moved: Box = { min: [b.min[0] + dx, b.min[1], b.min[2]], max: [b.max[0] + dx, b.max[1], b.max[2]] };
      const hit = placed.filter((p) => overlapXZ(moved, p));
      if (!hit.length) {
        placed.push(moved);
        break;
      }
      dx = Math.max(...hit.map((p) => p.max[0])) + STUD - b.min[0];
    }
    if (!dx) continue;
    const shift = new THREE.Matrix4().makeTranslation(dx, 0, 0);
    for (const i of g) {
      const pose = poses.get(i.key);
      if (pose) poses.set(i.key, shift.clone().multiply(pose));
    }
  }
}
