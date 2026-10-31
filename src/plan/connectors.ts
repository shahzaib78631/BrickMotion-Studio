import type { Vec3 } from '../ldraw/parse';
import type { PartMetrics } from '../ldraw/metrics';
import type { ColorDef } from '../ldraw/colors';
import type { Snap } from '../ldraw/shadow';
import { assemble, type Metrics } from '../model/assemble';
import { modelSteps } from './ops';
import { socketsOf } from './studSnap';
import type { Plan, Step } from './types';

/**
 * A stud-type connection point, in LDU part (or submodel) space. `axis` points out of the
 * connector, toward where its mate comes from: a top stud points up (−Y), an underside
 * socket points down (+Y). A male and a female mate when their `pos` coincide and their
 * axes are opposite. `type` is where pins and axles slot in later.
 */
export type Connector = { pos: Vec3; axis: Vec3; gender: 'M' | 'F'; type: 'stud' };

/** a plain round stud (radius 6 LDU), or a round socket that takes one: an anti-stud or a hinge tube such as a car door's */
export const isStudSnap = (s: Snap) => s.kind === 'cyl' && s.length > 0 && s.length <= (s.gender === 'M' ? 8 : 32) && s.shapes.length > 0
    // a round stud also seats in a square socket: the underside of 1-wide plates (4315) and special bases
    && s.shapes.every(x => x === 'R' || (s.gender === 'F' && x === 'S')) && Math.abs(s.radius - 6) <= .6;

const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const same = (a: Connector, b: Connector) => a.gender === b.gender &&
  Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) <= 1 &&
  a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2] > 0.999;

const cache = new WeakMap<PartMetrics, Connector[]>();

/** Every stud and anti-stud of a part, from its measured studs, its socket grid and its shadow snaps (deduped). */
export function partConnectors(m: PartMetrics): Connector[] {
  const hit = cache.get(m);
  if (hit) return hit;
  const out: Connector[] = [];
  const add = (c: Connector) => { if (!out.some((o) => same(o, c))) out.push(c); };
  for (const s of m.studs ?? []) add({ pos: [...s.base] as Vec3, axis: unit([s.tip[0] - s.base[0], s.tip[1] - s.base[1], s.tip[2] - s.base[2]]), gender: 'M', type: 'stud' });
  for (const p of socketsOf(m.body)) add({ pos: [p[0], p[1], p[2]], axis: [0, 1, 0], gender: 'F', type: 'stud' });
  // shadow snaps: a male's sections run out of the part, a female's run into it
  for (const s of m.snaps ?? []) {
    if (!isStudSnap(s)) continue;
    const a = unit(s.axis);
    add({ pos: [...s.start] as Vec3, axis: s.gender === 'M' ? a : [-a[0] || 0, -a[1] || 0, -a[2] || 0], gender: s.gender, type: 'stud' });
  }
  cache.set(m, out);
  return out;
}

/** Connectors moved by a column-major 4x4 (LDU). */
export function worldConnectors(list: readonly Connector[], e: ArrayLike<number>): Connector[] {
  return list.map((c) => {
    const p = c.pos, a = c.axis;
    return {
      ...c,
      pos: [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]],
      axis: unit([e[0] * a[0] + e[4] * a[1] + e[8] * a[2], e[1] * a[0] + e[5] * a[1] + e[9] * a[2], e[2] * a[0] + e[6] * a[1] + e[10] * a[2]]),
    };
  });
}

const subCache = new WeakMap<Step[], Connector[]>();

/** Connectors of a submodel's parts, in the submodel frame; cached per version of its steps. */
export function submodelConnectors(plan: Plan, name: string, metrics: Metrics, colors: Map<number, ColorDef>): Connector[] {
  const steps = modelSteps(plan, name);
  const hit = subCache.get(steps);
  if (hit) return hit;
  const view = assemble({ ...plan, steps }, metrics, colors);
  const out = view.instances.filter((i) => !i.placeholder).flatMap((i) => worldConnectors(partConnectors(metrics(i.part)), i.world.elements));
  subCache.set(steps, out);
  return out;
}
