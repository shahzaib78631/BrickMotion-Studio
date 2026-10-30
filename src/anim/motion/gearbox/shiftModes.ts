/**
 * The gearbox mode table (spec §4.1-4.2): for every state of the driving
 * rings, whether the output turns with the input, at what ratio, or whether
 * the box locks up. Found from the gear network alone, without the solver.
 *
 * Every relation here joins two bodies (a mesh, a locked differential, a
 * ring on its shaft, an engaged clutch), so rates are carried outward from
 * the input; a body reached twice at a different speed is a lock-up.
 */
import type { Assembly } from '../../../model/assemble';
import { worldFeatures } from '../gears/gearTable';
import type { HigherPair } from '../pairs/higherPairs';
import type { Recognition } from '../mobility/recognise';
import type { NamedMechanism } from '../classify/patterns';
import type { ShiftElement } from './shiftElements';

export type RateNetwork = {
  /** Mesh relations between recognition bodies: teethA·ωa + teethB·ωb = 0. */
  meshes: { a: number; b: number; teethA: number; teethB: number; pair: string }[];
  /** Bodies that turn together: locked differentials (driving straight). */
  locks: [number, number][];
};
export type GearMode = {
  id: string; label: string;
  engaged: { ring: string; gear: string }[];
  state: 'drive' | 'neutral' | 'locked';
  /** Input turns per output turn, unsigned; only when state is 'drive'. */
  ratio?: number;
};

/** Rings beyond this many are left in neutral (3^4 = 81 rows). */
const MAX_RINGS = 4;
const TOLERANCE = 1e-6;

const ON_LINE = 2.5;
const PARALLEL = Math.cos((4 * Math.PI) / 180);

/**
 * The gear network: meshes between bodies, each gear on a shaft (every hinge
 * of its body on the gear's own line; a gear on a body that also swings about
 * another line is not on a shaft and is left out), and every differential
 * locked, as when the vehicle drives straight.
 */
export function rateNetwork(rec: Recognition, pairs: readonly HigherPair[], named: readonly NamedMechanism[], asm: Assembly): RateNetwork {
  const world = new Map(asm.instances.map(i => [i.key, i.world]));
  const onBearing = (key: string, part: string, feature: number, body: number) => {
    const m = world.get(key), f = m && worldFeatures(key, part, m)[feature];
    if (!f) return false;
    const n = Math.hypot(...f.axis), u = f.axis.map(x => x / n);
    const bearings = rec.joints.filter(({ a, b, joint: j }) => (a === body || b === body) && j.kind === 'revolute' && j.axis && j.point);
    // A body on no bearing at all is loose (a gear missing its axle): kept, it can drive nothing else.
    if (!bearings.length) return true;
    // A shaft: every hinge of the body on one line, and the gear on that line.
    return bearings.every(({ joint: j }) => {
      const axis = j.axis!, point = j.point!, ja = Math.hypot(...axis), d = f.centre.map((x, i) => x - point[i]);
      const along = d.reduce((t, x, i) => t + x * u[i], 0);
      return Math.abs(axis.reduce((t, x, i) => t + x * u[i], 0)) / ja >= PARALLEL
        && Math.hypot(...d.map((x, i) => x - along * u[i])) <= ON_LINE;
    });
  };
  const meshes: RateNetwork['meshes'] = [];
  for (const p of pairs) {
    if (p.kind !== 'spur' && p.kind !== 'bevel' && p.kind !== 'crown' && p.kind !== 'clutch') continue;
    const a = rec.bodyOf.get(p.a), b = rec.bodyOf.get(p.b);
    if (a === undefined || b === undefined || a === b || !p.teethA || !p.teethB) continue;
    if (!onBearing(p.a, p.partA, p.featureA, a) || !onBearing(p.b, p.partB, p.featureB, b)) continue;
    meshes.push({ a, b, teethA: p.teethA, teethB: p.teethB, pair: p.id });
  }
  const locks: [number, number][] = named.filter(m => m.kind === 'differential')
    .flatMap(m => m.outputs.map((side): [number, number] => [m.drivers[0], side]));
  return { meshes, locks };
}

type Edge = { to: number; factor: number };
/** Rates of every body the input reaches, or null when two paths disagree. */
function propagate(edges: Map<number, Edge[]>, input: number): Map<number, number> | null {
  const rate = new Map([[input, 1]]), queue = [input];
  while (queue.length) {
    const x = queue.shift()!;
    for (const e of edges.get(x) ?? []) {
      const w = rate.get(x)! * e.factor, known = rate.get(e.to);
      if (known === undefined) { rate.set(e.to, w); queue.push(e.to); continue; }
      // Only magnitudes are compared: a bevel's turning sense depends on which way its axis is read.
      if (Math.abs(Math.abs(known) - Math.abs(w)) > TOLERANCE * Math.max(1, Math.abs(w))) return null;
    }
  }
  return rate;
}

export function shiftModes(net: RateNetwork, shifts: readonly ShiftElement[], input: number, output: number): GearMode[] {
  const rings = shifts.slice(0, MAX_RINGS);
  // Every combination of ring states: neutral (null) or one of its couplings.
  let states: (number | null)[][] = [[]];
  for (const r of rings) states = states.flatMap(s => [null, ...r.couplings.map((_, i) => i)].map(c => [...s, c]));
  const modes = states.map((state): GearMode => {
    const engaged = state.flatMap((c, i) => (c === null ? [] : [{ ring: rings[i].ring, gear: rings[i].couplings[c].gear }]));
    const edges = new Map<number, Edge[]>();
    const link = (a: number, b: number, factor: number) => {
      edges.set(a, [...(edges.get(a) ?? []), { to: b, factor }]);
      edges.set(b, [...(edges.get(b) ?? []), { to: a, factor: 1 / factor }]);
    };
    for (const m of net.meshes) link(m.a, m.b, -m.teethA / m.teethB);
    for (const [a, b] of net.locks) link(a, b, 1);
    for (const r of shifts) link(r.ringBody, r.shaftBody, 1);
    state.forEach((c, i) => { if (c !== null) link(rings[i].shaftBody, rings[i].couplings[c].gearBody, 1); });
    const id = state.map((c, i) => `${rings[i].ring}:${c === null ? 0 : rings[i].couplings[c].side > 0 ? '+' : '-'}`).join(' ');
    const label = engaged.length ? engaged.map(e => e.gear).join(' + ') : 'neutral';
    const rate = propagate(edges, input);
    if (!rate) return { id, label, engaged, state: 'locked' };
    const w = rate.get(output);
    if (w === undefined || Math.abs(w) < TOLERANCE) return { id, label, engaged, state: 'neutral' };
    return { id, label, engaged, state: 'drive', ratio: 1 / Math.abs(w) };
  });
  const [rest, ...others] = modes;
  const drive = others.filter(m => m.state === 'drive').sort((a, b) => b.ratio! - a.ratio!);
  return [rest, ...drive, ...others.filter(m => m.state !== 'drive')];
}
