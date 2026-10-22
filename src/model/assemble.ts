import * as THREE from 'three';
import { resolveColor, type ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import type { PartMetrics } from '../ldraw/metrics';
import type { Vec3 } from '../ldraw/parse';
import { gridToPlacement, type Placement } from '../plan/placement';
import { isGrid, isSub, type Plan, type PlanItem, type Step } from '../plan/types';

export type Metrics = (part: string) => PartMetrics;

type NodeBase = { itemId: string; model: string; step: number; order: number; pauseAfter?: number; local: Placement };
export type ANode =
  | (NodeBase & { kind: 'piece'; part: string; color: number; placeholder: boolean; body: Box; grid: boolean })
  | (NodeBase & { kind: 'sub'; submodel: string; children: ANode[]; body: Box });

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

export function transformBox(b: Box, mat: THREE.Matrix4): Box {
  const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).applyMatrix4(mat);
  const r = (n: number) => Math.round(n * 1000) / 1000 || 0;
  return { min: [r(box.min.x), r(box.min.y), r(box.min.z)], max: [r(box.max.x), r(box.max.y), r(box.max.z)] };
}

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
  return {
    min: a.min.map((v, i) => Math.min(v, b.min[i])) as Vec3,
    max: a.max.map((v, i) => Math.max(v, b.max[i])) as Vec3,
  };
}

function itemPlacement(item: PlanItem, body: Box): Placement {
  if (isGrid(item)) return gridToPlacement(item, body);
  return { pos: item.ldu, m: item.matrix };
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
          nodes.push({ kind: 'sub', itemId, model, step: si, order, pauseAfter, submodel: item.submodel, children, body, local: itemPlacement(item, body) });
          return;
        }
        const m = metrics(item.part);
        let color = DEFAULT_COLOR;
        if (item.color !== 16 && item.color !== '16') {
          const c = resolveColor(colors, item.color);
          if (c === undefined) report({ kind: 'unknown-color', model, itemId, detail: String(item.color) });
          else color = c;
        }
        nodes.push({ kind: 'piece', itemId, model, step: si, order, pauseAfter, part: item.part, color, placeholder: m.placeholder, body: m.body, grid: isGrid(item), local: itemPlacement(item, m.body) });
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
