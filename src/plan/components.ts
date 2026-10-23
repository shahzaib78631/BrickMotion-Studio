import type { ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import { assemble, placementMatrix, transformBox, type Metrics } from '../model/assemble';
import { autoSplitSteps, LARGE_STEP, modelsWithoutSteps } from './autoSteps';
import { modelSteps } from './ops';
import { isGrid, isSub, type Plan, type PlanItem, type SubItem } from './types';

/**
 * Splits a big LDraw model that has no build steps into components that are
 * built aside first and then attached, the way printed instructions build a
 * train: each bogie with its wheels, then the base onto them, then the roof as
 * one piece. Components are written as ordinary submodels, so the planner
 * builds each one on its own (a small, fast problem) and flies it in whole.
 *
 * Every piece keeps its exact position in the model; only grouping changes.
 */

/** models with fewer top-level items than this are left alone */
export const COMPONENT_MIN_ITEMS = 40;
/** a component needs at least this many items to be worth building aside */
const MIN_COMPONENT = 3;
/** the layer just above a roof cut must cover at least this share of the carrier */
const CAP_COVERAGE = 0.5;
/** the carrier must be this many times the median piece's footprint (a real base, not a brick) */
const CARRIER_RATIO = 8;
const MAX_CAPS = 4;
/** LDU a piece may reach across a cut (stud height plus authoring slop) */
const POKE = 6;

type Node = { item: PlanItem; index: number; box: Box };

const overlap = (a: Box, b: Box, k: number) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
/** in contact: no gap on any axis, and a real contact area on at least two axes */
const touching = (a: Box, b: Box) => [0, 1, 2].every((k) => overlap(a, b, k) >= -0.5) && [0, 1, 2].filter((k) => overlap(a, b, k) > 1).length >= 2;
const footprint = (b: Box) => (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
/** LDraw +Y is down: a larger centre Y is lower */
const centreY = (b: Box) => (b.min[1] + b.max[1]) / 2;

/** Whether a model is big enough, and made of imported placements, to be split. */
export function canSplitComponents(plan: Plan, model: string): boolean {
  const items = modelSteps(plan, model).flatMap((s) => s.pieces);
  // already split: its components are submodels named after it
  const own = `${model || plan.name || 'Model'} - `;
  if (items.some((i) => isSub(i) && i.submodel.startsWith(own) && /^(underside|top) \d+$/.test(i.submodel.slice(own.length)))) return false;
  return items.length >= COMPONENT_MIN_ITEMS && items.every((i) => !isGrid(i) && !i.assembly);
}

/** Step-less models big enough to split: done automatically on import. */
export function modelsToSplit(plan: Plan): string[] {
  return modelsWithoutSteps(plan).filter((m) => canSplitComponents(plan, m));
}

/** "Build in components" for one model: split it, then give big components layer steps. */
export function buildInComponents(plan: Plan, model: string, metrics: Metrics, colors: Map<number, ColorDef>): { plan: Plan; components: string[] } {
  const r = splitComponents(plan, model, metrics, colors);
  let next = r.plan;
  for (const c of r.components) if (modelSteps(next, c).reduce((n, s) => n + s.pieces.length, 0) > LARGE_STEP) next = autoSplitSteps(next, c, metrics, colors);
  return { plan: next, components: r.components };
}

/** Splits every qualifying model; returns the new plan and the components made. */
export function splitPlanComponents(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): { plan: Plan; components: string[] } {
  let next = plan;
  const components: string[] = [];
  for (const m of modelsToSplit(plan)) {
    const r = splitComponents(next, m, metrics, colors);
    next = r.plan;
    components.push(...r.components);
  }
  return { plan: next, components };
}

export function splitComponents(plan: Plan, model: string, metrics: Metrics, colors: Map<number, ColorDef>): { plan: Plan; components: string[] } {
  const steps = modelSteps(plan, model);
  const items = steps.flatMap((s) => s.pieces);
  const none = { plan, components: [] };
  if (!canSplitComponents(plan, model)) return none;

  // the model's own items, in its own space
  const asm = assemble({ ...plan, steps: [{ pieces: items }] }, metrics, colors);
  const byId = new Map(asm.nodes.map((n) => [n.itemId, n]));
  const nodes: Node[] = [];
  items.forEach((item, index) => {
    const n = byId.get(item.id ?? `:0:${index}`);
    if (n) nodes.push({ item, index, box: transformBox(n.body, placementMatrix(n.local)) });
  });
  if (nodes.length < COMPONENT_MIN_ITEMS) return none;
  const near = new Map<Node, Node[]>(nodes.map((n) => [n, []]));
  for (let a = 0; a < nodes.length; a++)
    for (let b = a + 1; b < nodes.length; b++)
      if (touching(nodes[a].box, nodes[b].box)) (near.get(nodes[a])!.push(nodes[b]), near.get(nodes[b])!.push(nodes[a]));

  // the carrier: the piece with the largest footprint (a train base, a baseplate)
  const pieces = nodes.filter((n) => !isSub(n.item));
  if (!pieces.length) return none;
  const carrier = pieces.reduce((a, b) => (footprint(b.box) > footprint(a.box) ? b : a));
  const sizes = pieces.map((n) => footprint(n.box)).sort((a, b) => a - b);
  if (footprint(carrier.box) < CARRIER_RATIO * sizes[sizes.length >> 1]) return none;
  const groups: { kind: 'underside' | 'top'; nodes: Node[] }[] = [];
  const taken = new Set<Node>([carrier]);

  /** connected pieces of `pool`, starting from `start` */
  const connected = (start: Node, pool: Set<Node>): Node[] => {
    const seen = new Set<Node>([start]), queue = [start];
    while (queue.length) for (const m of near.get(queue.pop()!)!) if (pool.has(m) && !seen.has(m)) (seen.add(m), queue.push(m));
    return [...seen];
  };

  // Below the carrier: each connected group (a bogie with its wheels and the
  // plates under the base) is built on the table, then the carrier comes down onto it.
  const below = new Set(nodes.filter((n) => n !== carrier && centreY(n.box) > centreY(carrier.box) + 1));
  for (const n of below) {
    if (taken.has(n)) continue;
    const group = connected(n, below);
    group.forEach((g) => taken.add(g));
    if (group.length >= MIN_COMPONENT) groups.push({ kind: 'underside', nodes: group });
  }

  // Above it: a roof is built aside and put on last, so the inside stays
  // reachable until then. The roof is everything above a horizontal cut where
  // the layer just above the cut covers most of the carrier (walls only cover a
  // thin ring), in the upper half of the model.
  const above = new Set(nodes.filter((n) => !taken.has(n)));
  const cell = 10;
  const cb = carrier.box;
  const cols = Math.max(1, Math.ceil((cb.max[0] - cb.min[0]) / cell)), rows = Math.max(1, Math.ceil((cb.max[2] - cb.min[2]) / cell));
  /** share of the carrier's footprint covered by these boxes */
  const coverage = (boxes: Box[]) => {
    const hit = new Uint8Array(cols * rows);
    for (const b of boxes)
      for (let i = 0; i < cols; i++) {
        const x = cb.min[0] + (i + 0.5) * cell;
        if (x < b.min[0] || x > b.max[0]) continue;
        for (let j = 0; j < rows; j++) {
          const z = cb.min[2] + (j + 0.5) * cell;
          if (z >= b.min[2] && z <= b.max[2]) hit[i * rows + j] = 1;
        }
      }
    return hit.reduce((n, v) => n + v, 0) / hit.length;
  };
  for (let caps = 0; caps < MAX_CAPS && above.size >= 2 * MIN_COMPONENT; caps++) {
    const list = [...above];
    const top = Math.min(...list.map((n) => n.box.min[1])), bottom = Math.max(...list.map((n) => n.box.max[1]));
    const mid = (top + bottom) / 2;
    // candidate cuts: piece bottoms in the upper half, lowest first (the biggest cap)
    const cuts = [...new Set(list.map((n) => Math.round(n.box.max[1])))].filter((y) => y < mid).sort((a, b) => b - a);
    let cap: Set<Node> | null = null;
    for (const y of cuts) {
      // nothing may pass through the cut (a stud or a hat tip poking into the roof's underside is fine)
      if (list.some((n) => n.box.min[1] < y - POKE && n.box.max[1] > y + POKE)) continue;
      const over = list.filter((n) => n.box.max[1] <= y + POKE && n.box.min[1] < y - POKE);
      const layer = over.filter((n) => n.box.max[1] >= y - 1);
      if (over.length < MIN_COMPONENT || list.length - over.length < MIN_COMPONENT) continue;
      if (coverage(layer.map((n) => n.box)) < CAP_COVERAGE) continue;
      cap = new Set(over);
      break;
    }
    if (!cap) break;
    // pieces hanging only from the cap (a lamp under the roof) go with it
    for (const n of above) {
      if (cap.has(n)) continue;
      const others = near.get(n)!.filter((m) => m !== carrier);
      if (others.length && others.every((m) => cap!.has(m))) cap.add(n);
    }
    if (above.size - cap.size < MIN_COMPONENT) break;
    groups.push({ kind: 'top', nodes: [...cap] });
    cap.forEach((n) => above.delete(n));
  }
  if (!groups.length) return none;

  // Write each group as a submodel whose origin is its bottom centre.
  const base = model || plan.name || 'Model';
  const names = new Set(Object.keys(plan.submodels ?? {}));
  const usedIds = new Set(items.map((i) => i.id).filter((id): id is string => !!id));
  const count = { underside: 0, top: 0 };
  const submodels = { ...plan.submodels };
  const replace = new Map<PlanItem, SubItem | null>();
  const made: string[] = [];
  for (const g of groups) {
    let name: string;
    do name = `${base} - ${g.kind === 'top' ? 'top' : 'underside'} ${++count[g.kind]}`;
    while (names.has(name));
    names.add(name);
    const box = g.nodes.reduce((b, n) => ({
      min: [0, 1, 2].map((k) => Math.min(b.min[k], n.box.min[k])) as Box['min'],
      max: [0, 1, 2].map((k) => Math.max(b.max[k], n.box.max[k])) as Box['max'],
    }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } as Box);
    const origin: [number, number, number] = [Math.round((box.min[0] + box.max[0]) / 2), Math.round(box.max[1]), Math.round((box.min[2] + box.max[2]) / 2)];
    const members = [...g.nodes].sort((a, b) => a.index - b.index);
    submodels[name] = {
      steps: [{ pieces: members.map(({ item }) => {
        if (!('ldu' in item)) return item;
        return { ...item, ldu: [item.ldu[0] - origin[0], item.ldu[1] - origin[1], item.ldu[2] - origin[2]] };
      }) }],
    };
    let id = `component-${made.length + 1}`;
    for (let k = 2; usedIds.has(id); k++) id = `component-${made.length + 1}-${k}`;
    usedIds.add(id);
    // the component takes the place of its first piece in the model's order
    replace.set(members[0].item, { id, submodel: name, ldu: origin, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    for (const m of members.slice(1)) replace.set(m.item, null);
    made.push(name);
  }
  const outSteps = steps.map((s) => ({
    ...s,
    pieces: s.pieces.flatMap((i) => (replace.has(i) ? (replace.get(i) ? [replace.get(i)!] : []) : [i])),
  })).filter((s) => s.pieces.length);
  const next: Plan = model === ''
    ? { ...plan, steps: outSteps, submodels }
    : { ...plan, submodels: { ...submodels, [model]: { steps: outSteps } } };
  return { plan: next, components: made };
}
