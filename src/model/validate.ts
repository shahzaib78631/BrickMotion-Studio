import type { Box } from '../ldraw/flatten';
import type { Assembly } from './assemble';
import { SpatialHash } from './spatialHash';

export type WarningKind = 'unknown-part' | 'unknown-color' | 'missing-submodel' | 'submodel-cycle' | 'overlap' | 'floating';
export type Warning = { kind: WarningKind; itemIds: string[]; instanceKeys: string[]; model: string; message: string };

const OVERLAP = 2; // LDU of interpenetration on every axis before it counts as an overlap
const CONTACT_GAP = 1; // LDU gap still treated as touching

function axisOverlap(a: Box, b: Box, i: number): number {
  return Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
}

export function validate(asm: Assembly, names: (part: string) => string = (p) => p): Warning[] {
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
  inst.forEach((i, idx) => hash.insert(idx, i.worldBox, CONTACT_GAP));

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
    if ((inst[i].grid || inst[j].grid) && o.every((v) => v > OVERLAP)) {
      out.push({
        kind: 'overlap',
        itemIds: [inst[i].itemId, inst[j].itemId],
        instanceKeys: [inst[i].key, inst[j].key],
        model: inst[i].model,
        message: `${names(inst[i].part)} overlaps ${names(inst[j].part)}`,
      });
    }
    // touching: small gap (or overlap) on one axis, real contact area on the other two
    const touching = [0, 1, 2].some((k) => o[k] >= -CONTACT_GAP && o.filter((_, m) => m !== k).every((v) => v > OVERLAP));
    if (touching) parent[find(i)] = find(j);
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
      if (!grounded.has(find(idx)) && !i.placeholder)
        out.push({ kind: 'floating', itemIds: [i.itemId], instanceKeys: [i.key], model: i.model, message: `${names(i.part)} is floating` });
    });
  }
  return out;
}
