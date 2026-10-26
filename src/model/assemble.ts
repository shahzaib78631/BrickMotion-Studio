import * as THREE from 'three';
import { resolveColor, type ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import type { PartMetrics } from '../ldraw/metrics';
import type { Vec3 } from '../ldraw/parse';
import { gridToPlacement, tidyPlacement, type Placement } from '../plan/placement';
import { isGrid, isSub, type Plan, type PlanItem, type Step, type AssemblyHints } from '../plan/types';

export type Metrics = (part: string) => PartMetrics;

import type { ANode } from './assemblyTypes';
export type { ANode } from './assemblyTypes';

export type Instance = {
  key: string;
  itemId: string;
  model: string;
  part: string;
  color: number;
  /** part space → world, in LDU */
  world: THREE.Matrix4;
  worldBox: Box;
  placeholder: boolean;
  /** placed on the stud grid (editor/AI) rather than imported with an exact position */
  grid: boolean;
};

export type AssemblyProblem = {
  kind: 'missing-submodel' | 'submodel-cycle' | 'unknown-color';
  model: string;
  itemId: string;
  detail: string;
};

export type Assembly = { nodes: ANode[]; instances: Instance[]; bounds: Box | null; problems: AssemblyProblem[] };

export const DEFAULT_COLOR = 71;
const MAX_DEPTH = 16;
const EMPTY_SUB_BOX: Box = { min: [0, -24, 0], max: [20, 0, 20] };

export function placementMatrix(p: Placement): THREE.Matrix4 {
  const m = p.m;
  return new THREE.Matrix4().set(m[0], m[1], m[2], p.pos[0], m[3], m[4], m[5], p.pos[1], m[6], m[7], m[8], p.pos[2], 0, 0, 0, 1);
}

/**
 * Axis-aligned bounds of an affinely transformed box. Uses the centre/extent form
 * (|M| · half-size) — the same result as transforming all eight corners, but with
 * no allocations. The animation planner calls this millions of times.
 */
export function transformBox(b: Box, mat: THREE.Matrix4): Box {
  const e = mat.elements;
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const hx = (b.max[0] - b.min[0]) / 2, hy = (b.max[1] - b.min[1]) / 2, hz = (b.max[2] - b.min[2]) / 2;
  const nx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
  const ny = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
  const nz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
  const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
  const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
  const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
  return { min: [round3(nx - ex), round3(ny - ey), round3(nz - ez)], max: [round3(nx + ex), round3(ny + ey), round3(nz + ez)] };
}
const round3 = (n: number) => Math.round(n * 1000) / 1000 || 0;

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function itemPlacement(item: PlanItem, body: Box): Placement {
  if (isGrid(item)) return gridToPlacement(item, body);
  return tidyPlacement({ pos: item.ldu, m: item.matrix });
}

/**
 * A copy of the assembly with a rigid transform applied at its root: every final pose is
 * multiplied by `S` (this moves the whole model to a chosen assembly spot before
 * planning). Node bodies and submodel frames keep their own local space; instances and
 * bounds are recomputed exactly, so collision checks see the real, moved model.
 */
export function moveAssembly(asm: Assembly, S: THREE.Matrix4): Assembly {
  const place = (p: Placement): Placement => {
    const m = S.clone().multiply(placementMatrix(p));
    const e = m.elements;
    // Placement.m is row-major: its first three numbers are the matrix's first row.
    return { pos: [e[12], e[13], e[14]], m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] };
  };
  const nodes = asm.nodes.map((n) => ({ ...n, local: place(n.local) }) as ANode);
  const source = new Map(asm.instances.map((i) => [i.key, i]));
  const instances: Instance[] = [];
  let bounds: Box | null = null;
  const collect = (list: ANode[], parent: THREE.Matrix4, prefix: string) => {
    for (const n of list) {
      const world = parent.clone().multiply(placementMatrix(n.local));
      const key = prefix ? `${prefix}/${n.itemId}` : n.itemId;
      if (n.kind === 'sub') {
        collect(n.children, world, key);
        continue;
      }
      const worldBox = transformBox(n.body, world);
      bounds = unionBox(bounds, worldBox);
      instances.push({ ...source.get(key)!, world, worldBox });
    }
  };
  collect(nodes, new THREE.Matrix4(), '');
  return { nodes, instances, bounds, problems: asm.problems };
}

export function assemble(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): Assembly {
  const problems: AssemblyProblem[] = [];
  const reported = new Set<string>();
  const report = (p: AssemblyProblem) => {
    const k = `${p.kind}|${p.model}|${p.itemId}`;
    if (!reported.has(k)) {
      reported.add(k);
      problems.push(p);
    }
  };
  const subBodies = new Map<string, Box | null>();

  /** Builds the nodes of a model in its own space. */
  const buildModel = (model: string, steps: Step[], stack: string[]): ANode[] => {
    const nodes: ANode[] = [];
    steps.forEach((step, si) => {
      step.pieces.forEach((item, order) => {
        const itemId = item.id ?? `${model}:${si}:${order}`;
        const pauseAfter = step.pauseAfter;
        const autoStep = step.auto || undefined;
        if (isSub(item)) {
          const def = plan.submodels?.[item.submodel];
          if (!def) {
            report({ kind: 'missing-submodel', model, itemId, detail: item.submodel });
            return;
          }
          if (stack.includes(item.submodel) || stack.length >= MAX_DEPTH) {
            report({ kind: 'submodel-cycle', model, itemId, detail: [...stack, item.submodel].join(' → ') });
            return;
          }
          const children = buildModel(item.submodel, def.steps, [...stack, item.submodel]);
          const body = subBody(item.submodel, children);
          nodes.push({ kind: 'sub', assembly: item.assembly, itemId, model, step: si, order, pauseAfter, autoStep, submodel: item.submodel, children, body, local: itemPlacement(item, body) });
          return;
        }
        const m = metrics(item.part);
        let color = DEFAULT_COLOR;
        if (item.color !== 16 && item.color !== '16') {
          const c = resolveColor(colors, item.color);
          if (c === undefined) report({ kind: 'unknown-color', model, itemId, detail: String(item.color) });
          else color = c;
        }
        nodes.push({ kind: 'piece', assembly: item.assembly, itemId, model, step: si, order, pauseAfter, autoStep, part: item.part, color, placeholder: m.placeholder, body: m.body, grid: isGrid(item), local: itemPlacement(item, m.body) });
      });
    });
    return nodes;
  };

  const subBody = (name: string, children: ANode[]): Box => {
    if (subBodies.has(name)) return subBodies.get(name) ?? EMPTY_SUB_BOX;
    let b: Box | null = null;
    for (const n of children) b = unionBox(b, transformBox(n.body, placementMatrix(n.local)));
    subBodies.set(name, b);
    return b ?? EMPTY_SUB_BOX;
  };

  const nodes = buildModel('', plan.steps, []);
  const instances: Instance[] = [];
  let bounds: Box | null = null;
  const collect = (list: ANode[], parent: THREE.Matrix4, prefix: string) => {
    for (const n of list) {
      const world = parent.clone().multiply(placementMatrix(n.local));
      const key = prefix ? `${prefix}/${n.itemId}` : n.itemId;
      if (n.kind === 'sub') {
        collect(n.children, world, key);
        continue;
      }
      const worldBox = transformBox(n.body, world);
      bounds = unionBox(bounds, worldBox);
      instances.push({ key, itemId: n.itemId, model: n.model, part: n.part, color: n.color, world, worldBox, placeholder: n.placeholder, grid: n.grid });
    }
  };
  collect(nodes, new THREE.Matrix4(), '');
  return { nodes, instances, bounds, problems };
}
