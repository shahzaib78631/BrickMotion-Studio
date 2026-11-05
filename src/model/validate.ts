import type { Box } from '../ldraw/flatten';
import type { Assembly, Instance } from './assemble';
import { SpatialHash } from './spatialHash';
import type { Snap } from '../ldraw/shadow';
import { mateAxes, worldSnaps, type WorldSnap } from '../anim/snapMates';
import { discoverPlacedAttachments } from './attachmentPlacements';

export type WarningKind = 'unknown-part' | 'unknown-color' | 'missing-submodel' | 'submodel-cycle' | 'overlap' | 'floating' | 'assembly-spot';
export type Warning = {
  kind: WarningKind; itemIds: string[]; instanceKeys: string[]; model: string; message: string;
  /** The measured number behind the message, e.g. how deep two pieces reach into each other. */
  detail?: string;
};

const OVERLAP = 2; // LDU of interpenetration on every axis before it counts as an overlap
const CONTACT_GAP = 1; // LDU gap still treated as touching
const SNAP_REACH = 8; // LDU: how far apart two boxes may be and still be joined by a stud or clip

function axisOverlap(a: Box, b: Box, i: number): number {
  return Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
}

/**
 * `snapsOf` (the parts' LDCad connectors) lets pieces joined by a real stud, clip or
 * pin count as connected even when their boxes barely meet: a 1 x 1 round plate
 * mounted sideways as a headlight touches its neighbour along a 1 LDU strip only.
 *
 * `conflicts` confirms a box overlap against the real solids. Boxes are only a prefilter:
 * hollow, stepped and side-stud parts (22885, slopes, brackets) have empty space inside
 * their bounds, and a piece tucked into that space is not an overlap — the editor's own
 * guard allows it. Passing it keeps this list and the red highlight agreeing with the
 * editor. Leave it out and every box overlap is reported.
 */
export function validate(
  asm: Assembly,
  names: (part: string) => string = (p) => p,
  snapsOf?: (part: string) => Snap[] | undefined,
  conflicts?: (a: Instance, b: Instance) => boolean,
): Warning[] {
  const out: Warning[] = [];
  const inst = asm.instances;

  for (const p of asm.problems) {
    const messages = {
      'missing-submodel': `Submodel "${p.detail}" does not exist`,
      'submodel-cycle': `Submodel loop: ${p.detail}`,
      'unknown-color': `Unknown color "${p.detail}"`,
    } as const;
    out.push({ kind: p.kind, itemIds: [p.itemId], instanceKeys: [], model: p.model, message: messages[p.kind] });
  }
  for (const i of inst) {
    if (i.placeholder)
      out.push({ kind: 'unknown-part', itemIds: [i.itemId], instanceKeys: [i.key], model: i.model, message: `Unknown part "${i.part}"` });
  }

  const hash = new SpatialHash(40);
  inst.forEach((i, idx) => hash.insert(idx, i.worldBox, snapsOf ? SNAP_REACH / 2 : CONTACT_GAP));
  const placed = new Map<number, WorldSnap[]>();
  const snapsAt = (idx: number) => {
    let w = placed.get(idx);
    if (!w) placed.set(idx, (w = worldSnaps(snapsOf!(inst[idx].part), inst[idx].world.elements)));
    return w;
  };

  const parent = inst.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };

  for (const [i, j] of hash.pairs()) {
    const a = inst[i].worldBox;
    const b = inst[j].worldBox;
    const o = [0, 1, 2].map((k) => axisOverlap(a, b, k));
    // imported pieces come from real designs whose parts legitimately interlock, so only check pairs involving grid pieces
    if ((inst[i].grid || inst[j].grid) && o.every((v) => v > OVERLAP) && (!conflicts || conflicts(inst[i], inst[j]))) {
      out.push({
        kind: 'overlap',
        itemIds: [inst[i].itemId, inst[j].itemId],
        instanceKeys: [inst[i].key, inst[j].key],
        model: inst[i].model,
        message: `${names(inst[i].part)} overlaps ${names(inst[j].part)}`,
        detail: `${o.map((v) => Math.round(v)).join(' × ')} LDU inside each other`,
      });
    }
    // touching: small gap (or overlap) on one axis, real contact area on the other two
    const touching = [0, 1, 2].some((k) => o[k] >= -CONTACT_GAP && o.filter((_, m) => m !== k).every((v) => v > OVERLAP));
    if (touching) parent[find(i)] = find(j);
    else if (snapsOf && find(i) !== find(j) && mateAxes(snapsAt(i), snapsAt(j)).length) parent[find(i)] = find(j);
  }

  // Reviewed friction slots can connect bodies without any LDCad socket
  // and without their AABBs looking like normal stud contacts. Do not use
  // mirrored display references to infer physical support or waive overlaps.
  const keyToIndex = new Map(inst.map((i, idx) => [i.key, idx] as const));
  for (const hit of discoverPlacedAttachments(inst.filter((i) => !i.placeholder).map((i) => ({
    id: i.key, part: i.part, world: i.world.elements,
  })))) {
    if (hit.slot.mirrored) continue;
    const a = keyToIndex.get(hit.host), b = keyToIndex.get(hit.insert);
    if (a !== undefined && b !== undefined) parent[find(a)] = find(b);
  }

  if (inst.length) {
    // Each placed submodel is its own object resting on its own lowest point, so a
    // minifig standing a few LDU lower than a truck's tyres does not make the truck
    // float. Loose main-model pieces share the overall ground.
    const objectOf = (i: (typeof inst)[number]) => (i.key.includes('/') ? i.key.slice(0, i.key.indexOf('/')) : '');
    const overall = Math.max(...inst.map((i) => i.worldBox.max[1]));
    const ground = new Map<string, number>();
    for (const i of inst) {
      const o = objectOf(i);
      if (o) ground.set(o, Math.max(ground.get(o) ?? -Infinity, i.worldBox.max[1]));
    }
    const grounded = new Set<number>();
    inst.forEach((i, idx) => {
      if ((ground.get(objectOf(i)) ?? overall) - i.worldBox.max[1] <= CONTACT_GAP) grounded.add(find(idx));
    });
    inst.forEach((i, idx) => {
      if (!grounded.has(find(idx)) && !i.placeholder) {
        const o = objectOf(i);
        const gap = (ground.get(o) ?? overall) - i.worldBox.max[1];
        out.push({
          kind: 'floating', itemIds: [i.itemId], instanceKeys: [i.key], model: i.model, message: `${names(i.part)} is floating`,
          detail: `touches no piece; ${Math.round(gap)} LDU above the lowest point of ${o ? `"${o}"` : 'the model'}`,
        });
      }
    });
  }
  return out;
}
