/**
 * Suspension (spec §5.6): a shock's slide room from its two parts, and a
 * sweep of a suspension mechanism that reads camber gain and bump steer (toe
 * change over wheel travel) from the wheel's pose.
 *
 * Stroke: the outer part's bore takes the inner part's piston rod (the rod
 * segment whose radius fits the bore). It extends until only MIN_ENGAGE of
 * the rod is left in the bore, and compresses until the inner part's collar
 * (its first segment wider than the bore, outside the piston) meets the outer
 * part's end, or the piston reaches the bottom of the bore.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import { partFunctions } from '../parts/partFunctions';
import { MechanismSolver } from '../v4/mechanismSolver';
import { solveLabFrame } from '../v4/mechanismLab';
import type { MechanismProgram, Vec3 } from '../v4/mechanismProgram';

/** Rod left in the bore at full extension, LDU. */
const MIN_ENGAGE = 4;
/** A rod fits a bore within this radius, LDU. */
const FIT = 0.5;
const PARALLEL = Math.cos((4 * Math.PI) / 180);

export type Stroke = { min: number; max: number; inner: string; outer: string; out: Vec3 };
export type SweepSample = { travel: number; camberDeg: number; toeDeg: number };
export type SuspensionSweep = { samples: SweepSample[]; travelLdu: number; camberGainDegPerLdu: number; bumpSteerDeg: number; strokeMeasured: boolean };

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const deg = (r: number) => (r * 180) / Math.PI;

/** Slide room of a shock along `axis`, as [−compression, extension] of the inner part away from the outer; either order of parts. */
export function shockStroke(asm: Assembly, a: string, b: string, axis: Vec3): Stroke | null {
  const inst = new Map(asm.instances.map(i => [i.key, i]));
  const w = v3(axis).normalize();
  const tryPair = (inner: string, outer: string): Stroke | null => {
    const I = inst.get(inner), O = inst.get(outer), fi = I && partFunctions(I.part), fo = O && partFunctions(O.part);
    if (!I || !O || !fi || !fo) return null;
    const along = (m: THREE.Matrix4, centre: readonly number[], dir: readonly number[], x: number) =>
      v3(centre).applyMatrix4(m).add(v3(dir).transformDirection(m).multiplyScalar(x)).dot(w);
    for (const bore of fo.bores) {
      if (Math.abs(v3(bore.axis).transformDirection(O.world).dot(w)) < PARALLEL) continue;
      const bEnds = bore.travel.map(t => along(O.world, bore.centre, bore.axis, t));
      for (const rod of fi.rods) {
        if (Math.abs(v3(rod.axis).transformDirection(I.world).dot(w)) < PARALLEL) continue;
        const segs = rod.segments.map(([f, t, r]) => { const e = [along(I.world, rod.centre, rod.axis, f), along(I.world, rod.centre, rod.axis, t)]; return { lo: Math.min(...e), hi: Math.max(...e), r }; });
        const pistons = segs.filter(s => Math.abs(s.r - bore.radius) <= FIT);
        if (!pistons.length) continue;
        const piston = pistons.reduce((p, s) => (s.hi - s.lo > p.hi - p.lo ? s : p));
        // Outward: from the bore toward the bulk of the inner part.
        const mid = (segs.reduce((s, x) => s + x.lo + x.hi, 0) / (2 * segs.length)), bMid = (bEnds[0] + bEnds[1]) / 2;
        const e = Math.sign(mid - bMid) || 1, u = (x: number) => e * x;
        const p = [u(piston.lo), u(piston.hi)].sort((x, y) => x - y), bb = bEnds.map(u).sort((x, y) => x - y);
        const inserted = Math.min(p[1], bb[1]) - Math.max(p[0], bb[0]);
        if (inserted <= 0) continue;
        const extension = Math.max(0, inserted - MIN_ENGAGE);
        // Compression: the collar meets the outer part's end, or the piston bottoms in the bore.
        const outerEnd = Math.max(bb[1], ...fo.rods.flatMap(r => r.segments.flatMap(([f, t]) => [u(along(O.world, r.centre, r.axis, f)), u(along(O.world, r.centre, r.axis, t))])));
        const collars = segs.map(s => ({ lo: Math.min(u(s.lo), u(s.hi)), r: s.r })).filter(s => s.r > bore.radius + FIT && s.lo >= p[1] - FIT);
        const toCollar = collars.length ? Math.min(...collars.map(s => s.lo)) - outerEnd : Infinity;
        const toBottom = p[0] >= bb[0] ? p[0] - bb[0] : Infinity;
        const compression = Math.min(toCollar, toBottom);
        if (!Number.isFinite(compression)) continue;
        return { min: -Math.max(0, compression), max: extension, inner, outer, out: w.clone().multiplyScalar(e).toArray() as Vec3 };
      }
    }
    return null;
  };
  return tryPair(a, b) ?? tryPair(b, a);
}

/** Drive the suspension to both ends of its travel (stopping where it can go no further) and read the wheel. */
export function sweepSuspension(asm: Assembly, program: MechanismProgram, tyre: string, steps = 16): SuspensionSweep {
  const inst = asm.instances.find(i => i.key === tyre);
  if (!inst) throw Error(`No tyre ${tyre}`);
  const seat = partFunctions(inst.part)?.seats.find(s => s.gender === 'F');
  const centre0 = v3(seat?.centre ?? [0, 0, 0]).applyMatrix4(inst.world), axis0 = v3(seat?.axis ?? [1, 0, 0]).transformDirection(inst.world).normalize();
  // Outward: away from the middle of the model, so camber reads the same either side.
  const b = asm.bounds, middle = b ? v3(b.min).add(v3(b.max)).multiplyScalar(0.5) : new THREE.Vector3();
  if (axis0.x * (centre0.x - middle.x) + axis0.z * (centre0.z - middle.z) < 0) axis0.negate();
  const solver = new MechanismSolver(asm, program), A = program.driver.amplitude;
  const read = (frame: ReadonlyMap<string, THREE.Matrix4>): SweepSample => {
    const pose = frame.get(tyre) ?? inst.world, delta = pose.clone().multiply(inst.world.clone().invert());
    const c = centre0.clone().applyMatrix4(delta), a = axis0.clone().transformDirection(delta).normalize();
    const toe = Math.atan2(axis0.z * a.x - axis0.x * a.z, axis0.x * a.x + axis0.z * a.z);
    return { travel: centre0.y - c.y, camberDeg: deg(Math.asin(Math.max(-1, Math.min(1, a.y)))), toeDeg: deg(toe) };
  };
  solver.assembled();
  const samples = [read(solveLabFrame(solver, 0))];
  for (const end of [-1, 1]) {
    solver.assembled();
    for (let i = 1; i <= steps; i++) {
      try { samples.push(read(solveLabFrame(solver, (end * A * i) / steps))); } catch { break; }
    }
  }
  samples.sort((x, y) => x.travel - y.travel);
  const n = samples.length, mt = samples.reduce((s, x) => s + x.travel, 0) / n, mc = samples.reduce((s, x) => s + x.camberDeg, 0) / n;
  const vt = samples.reduce((s, x) => s + (x.travel - mt) ** 2, 0);
  const gain = vt > 1e-12 ? samples.reduce((s, x) => s + (x.travel - mt) * (x.camberDeg - mc), 0) / vt : 0;
  const toes = samples.map(x => x.toeDeg);
  return {
    samples, travelLdu: samples[n - 1].travel - samples[0].travel, camberGainDegPerLdu: gain,
    bumpSteerDeg: Math.max(...toes) - Math.min(...toes),
    strokeMeasured: program.joints.some(j => j.kind === 'prismatic' && j.limits?.source === 'verified'),
  };
}
