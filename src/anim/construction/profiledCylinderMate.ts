/**
 * Construction V3 profile-aware coaxial connector matching.
 *
 * This module owns the implementation: no runtime import from snapMates.
 * Only type imports are used to avoid a circular module dependency. Matching
 * a connector creates a kinematic hint, NEVER a swept-collision exemption.
 */
import type { Snap } from '../../ldraw/shadow';
import type { WorldSnap } from '../snapMates';
import { axisLineFits, type ToleratedFit } from './toleratedFit';

const RADIUS_SLOP = 0.6;
const AXIS_SLOP = 1.2;
const PARALLEL = Math.cos((4 * Math.PI) / 180);
/** A misfit shorter than this (LDU) is hand-placement rounding, not a shoulder in the way. */
const MISFIT_SLOP = 0.5;
const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A matched axial overlap, in WORLD space. This is connection topology, never a
 * permit to omit or shorten a moving-part collision test.
 */
export type ProfiledCylinderMate = {
  axis: [number, number, number];
  origin: [number, number, number];
  length: number;
  radius: number;
  male: WorldSnap;
  female: WorldSnap;
  profile: 'sectional' | 'legacy';
  /** Placement errors accepted for this fit (empty when the file is exact). */
  tolerated: ToleratedFit[];
};

type Section = { shape: string; radius: number; start: number; length: number };
const sectionsOf = (snap: Snap): Section[] => snap.sections?.length
  ? snap.sections : [{ shape: snap.shapes[0] ?? 'R', radius: snap.radius, start: 0, length: snap.length }];
/** Round sections: plain (R) and LDCad's chamfered lead-in edges (L, _L, L_). */
const round = (shape: string) => shape === 'R' || /^_?L_?$/.test(shape);
const sectionFits = (male: Section, female: Section): boolean => {
  if (!Number.isFinite(male.radius) || !Number.isFinite(female.radius) || male.radius <= 0 || female.radius <= 0) return false;
  const m = male.shape.toUpperCase(), f = female.shape.toUpperCase();
  // A cross hole only takes an axle; an axle also passes through a round
  // Technic hole (where it can turn).
  if (f === 'A') return m === 'A' && male.radius <= female.radius + RADIUS_SLOP;
  if (m === 'A') return f === 'R' && male.radius <= female.radius + RADIUS_SLOP;
  if (m === 'S') return f === 'S' && male.radius <= female.radius + RADIUS_SLOP;
  // Classic square anti-studs accept a round standard stud, not an arbitrary cylinder.
  if (f === 'S') return m === 'R' && male.radius >= 5.4 && male.radius <= 6.6 && male.radius <= female.radius + RADIUS_SLOP;
  if (!round(f) || !round(m)) return false;
  return male.radius <= female.radius + RADIUS_SLOP;
};

/**
 * A multi-section snap must fit over ALL of its engaged length. The old largest-
 * radius check incorrectly rejected tapered plugs; a smallest-radius check would
 * incorrectly accept an oversized shoulder. Both are fixed by comparing actual
 * coincident section intervals. No invented joints for parallel-but-distant axes.
 */
export function profiledCylinderMate(a: WorldSnap, b: WorldSnap): ProfiledCylinderMate | null {
  if (a.snap.kind !== 'cyl' || b.snap.kind !== 'cyl' || a.snap.gender === b.snap.gender) return null;
  const male = a.snap.gender === 'M' ? a : b, female = male === a ? b : a;
  if (Math.abs(dot(male.axis, female.axis)) < PARALLEL) return null;
  const delta = [female.start[0] - male.start[0], female.start[1] - male.start[1], female.start[2] - male.start[2]];
  const along = dot(delta, male.axis);
  if (Math.hypot(...delta.map((x,k)=>x - male.axis[k]*along)) > AXIS_SLOP) return null;
  const facing = dot(male.axis, female.axis);
  let first = Infinity, last = -Infinity, radius = 0, misfit = 0;
  for (const m of sectionsOf(male.snap)) for (const f of sectionsOf(female.snap)) {
    if (m.length <= 0 || f.length <= 0) continue;
    const fm = along + facing * f.start, fn = along + facing * (f.start + f.length);
    const lo = Math.max(m.start, Math.min(fm,fn));
    const hi = Math.min(m.start + m.length, Math.max(fm,fn));
    if (hi - lo <= 1e-4) continue;
    // Reject the entire joint if ANY physically engaged section cannot fit.
    if (!sectionFits(m, f)) { if (hi - lo <= MISFIT_SLOP) { misfit += hi - lo; continue; } return null; }
    first = Math.min(first, lo); last = Math.max(last, hi);
    radius = Math.max(radius, m.radius, f.radius);
  }
  if (!Number.isFinite(first) || last - first < 0.1) return null;
  const tolerated = axisLineFits(male.start, male.axis, female.start, female.axis, AXIS_SLOP, 4, 'pin/axle and hole');
  if (misfit > 0) tolerated.push({ rule: 'section-misfit', measured: misfit, allowed: MISFIT_SLOP, unit: 'LDU',
    detail: `a ${misfit.toFixed(2)} LDU stretch of the inserted part is wider than the hole (accepted up to ${MISFIT_SLOP}); slide one part ${misfit.toFixed(2)} LDU along the axis` });
  return {
    axis: [...male.axis] as [number,number,number],
    origin: male.start.map((x,k)=> x+first*male.axis[k]) as [number,number,number],
    length: last-first,
    radius,
    male, female,
    profile: male.snap.sections?.length && female.snap.sections?.length ? 'sectional' : 'legacy',
    tolerated,
  };
}
