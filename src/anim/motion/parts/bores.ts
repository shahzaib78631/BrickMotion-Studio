/**
 * Round surfaces, bores, rods and seats measured from a part's triangles.
 *
 * A triangle whose normal points straight away from (or toward) an axis, with
 * all three corners at one distance from it, lies on an outer (or inner)
 * cylinder about that axis. Collecting them per radius gives the part's round
 * surfaces. From those:
 *  - a bore is a long inner surface (a shock absorber cylinder, an engine
 *    cylinder), something may slide in;
 *  - a seat is a wide round surface (a tyre's inside, a rim's outside);
 *  - a rod is a stretch of the part that fits within a radius of the axis
 *    (a piston, a shock absorber rod), measured slice by slice.
 * Axes are the part's own X, Y and Z through its origin, where LDraw parts
 * put their round features.
 */
import type { FlatPart } from '../../../ldraw/flatten';
import type { V3 } from './teeth';

export type Bore = { axis: V3; centre: V3; radius: number; shape: string; travel: [number, number] };
export type Seat = { axis: V3; centre: V3; radius: number; width: number; gender: 'M' | 'F' };
/** Stretches along `axis` (through `centre`) that fit within a radius: [from, to, radius] in axial LDU. */
export type Rod = { axis: V3; centre: V3; segments: [number, number, number][] };

/** Inner surfaces from 5.5 (a pin-sized bore) to 16 LDU, at least 24 long (longer than any pin hole). */
const BORE_RADIUS: [number, number] = [5.5, 16], BORE_LENGTH = 24;
/** Seats are wider than any connector (bush flanges reach 9-10 LDU). */
const SEAT_RADIUS = 12, SEAT_WIDTH = 4;
/** Rods: up to the largest bore, kept when some stretch is at least 8 long. */
const ROD_RADIUS = 12.5, ROD_LENGTH = 8;
/** A surface must go at least 330 degrees round (72 bins of 5 degrees). */
const ROUND = 66;

const AXES: [number, number, number][] = [[1, 2, 0], [2, 0, 1], [0, 1, 2]]; // [u, v, axis]
const unit = (k: number): V3 => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
const at = (k: number, z: number): V3 => { const p: V3 = [0, 0, 0]; p[k] = z + 0; return p; };
const round = (x: number, d = 100) => Math.round(x * d) / d + 0;

type Surface = { k: number; radius: number; outward: boolean; from: number; to: number };
type Tri = number[];

function triangles(flat: FlatPart, certifiedOnly: boolean): Tri[] {
  const out: Tri[] = [];
  for (const map of certifiedOnly ? [flat.tris] : [flat.tris, flat.doubleSided])
    for (const list of map.values()) for (let i = 0; i + 8 < list.length; i += 9) out.push(list.slice(i, i + 9));
  return out;
}

/** Round surfaces about each part axis: contiguous axial runs at one radius, going (almost) all the way round. */
export function roundSurfaces(flat: FlatPart): Surface[] {
  const tris = triangles(flat, true), out: Surface[] = [];
  for (const [ui, vi, k] of AXES) {
    const bins = new Map<string, { radius: number; outward: boolean; spans: [number, number][]; angles: Set<number> }>();
    for (const t of tris) {
      const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl < 1e-9 || Math.abs(n[k]) / nl > 0.05) continue;
      const r = [0, 3, 6].map(i => Math.hypot(t[i + ui], t[i + vi]));
      const radius = Math.max(...r);
      if (radius < 2 || radius - Math.min(...r) > 0.05) continue;
      const cu = (t[ui] + t[3 + ui] + t[6 + ui]) / 3, cv = (t[vi] + t[3 + vi] + t[6 + vi]) / 3;
      const radial = (n[ui] * cu + n[vi] * cv) / (nl * Math.hypot(cu, cv));
      if (Math.abs(radial) < 0.95) continue;
      const key = `${radius.toFixed(1)}|${radial > 0}`;
      const b = bins.get(key) ?? bins.set(key, { radius, outward: radial > 0, spans: [], angles: new Set() }).get(key)!;
      const zs = [t[k], t[3 + k], t[6 + k]];
      b.spans.push([Math.min(...zs), Math.max(...zs)]);
      // Mark every 5 degree bin the triangle covers.
      const c0 = Math.atan2(cv, cu);
      const rel = [0, 3, 6].map(i => { let d = Math.atan2(t[i + vi], t[i + ui]) - c0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; });
      for (let a = Math.min(...rel); a <= Math.max(...rel) + 1e-9; a += Math.PI / 72)
        b.angles.add(Math.floor((((c0 + a) * 180) / Math.PI + 360) % 360 / 5) % 72);
    }
    for (const b of bins.values()) {
      if (b.angles.size < ROUND) continue;
      b.spans.sort((p, q) => p[0] - q[0]);
      let cur: [number, number] | null = null;
      const flush = () => { if (cur && cur[1] - cur[0] > 0.1) out.push({ k, radius: b.radius, outward: b.outward, from: cur[0], to: cur[1] }); };
      for (const s of b.spans) {
        if (cur && s[0] <= cur[1] + 0.5) cur[1] = Math.max(cur[1], s[1]);
        else { flush(); cur = [...s]; }
      }
      flush();
    }
  }
  return out;
}

/**
 * Long round inner surfaces. Whether something slides in one is decided per
 * pair in the assembly (libraryConnectors.ts): a part that fills it and has no
 * other connector to it.
 */
export function measureBores(surfaces: Surface[]): Bore[] {
  return surfaces.filter(s => !s.outward && s.radius >= BORE_RADIUS[0] && s.radius <= BORE_RADIUS[1] && s.to - s.from >= BORE_LENGTH)
    .map(s => ({ axis: unit(s.k), centre: at(s.k, round(s.from)), radius: round(s.radius), shape: 'round', travel: [0, round(s.to - s.from)] as [number, number] }));
}

/** Wide round surfaces, one per axis, radius and side: a tyre's bead rings count as one seat across the tyre. */
export function measureSeats(surfaces: Surface[]): Seat[] {
  const joined = new Map<string, Surface>();
  for (const s of surfaces) {
    if (s.radius < SEAT_RADIUS) continue;
    const key = `${s.k}|${s.radius.toFixed(1)}|${s.outward}`, j = joined.get(key);
    if (j) { j.from = Math.min(j.from, s.from); j.to = Math.max(j.to, s.to); } else joined.set(key, { ...s });
  }
  return [...joined.values()].filter(s => s.to - s.from >= SEAT_WIDTH).map(s => ({
    axis: unit(s.k), centre: at(s.k, round((s.from + s.to) / 2)), radius: round(s.radius), width: round(s.to - s.from), gender: s.outward ? 'M' : 'F',
  }));
}

/** Stretches of the part within ROD_RADIUS of each axis, from 1 LDU slices of all its triangles. */
export function measureRods(flat: FlatPart): Rod[] {
  const tris = triangles(flat, false), out: Rod[] = [];
  const box = flat.fullBox;
  if (!box || !tris.length) return out;
  for (const [ui, vi, k] of AXES) {
    const lo = Math.floor(box.min[k]), hi = Math.ceil(box.max[k]), n = hi - lo;
    if (n < ROD_LENGTH || n > 2000) continue;
    const max = new Float64Array(n).fill(-1);
    for (const t of tris) {
      const zs = [t[k], t[3 + k], t[6 + k]], z0 = Math.min(...zs), z1 = Math.max(...zs);
      const r = Math.max(...[0, 3, 6].map(i => Math.hypot(t[i + ui], t[i + vi])));
      // The slices the triangle reaches into. A face lying flat on a slice
      // boundary counts for neither side: the walls beside it carry its radius.
      let a: number, b: number;
      if (z1 - z0 < 1e-6) {
        if (Math.abs(z0 - Math.round(z0)) < 1e-6) continue;
        a = b = Math.floor(z0 - lo);
      } else {
        a = Math.floor(z0 - lo + 1e-6);
        b = Math.ceil(z1 - lo - 1e-6) - 1;
      }
      for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) if (r > max[i]) max[i] = r;
    }
    const segments: [number, number, number][] = [];
    let cur: [number, number, number] | null = null;
    for (let i = 0; i < n; i++) {
      const r = max[i];
      if (r < 0 || r > ROD_RADIUS) { if (cur) segments.push(cur); cur = null; continue; }
      if (cur && Math.abs(r - cur[2]) <= 0.5) { cur[1] = lo + i + 1; cur[2] = Math.max(cur[2], r); continue; }
      if (cur) segments.push(cur);
      cur = [lo + i, lo + i + 1, r];
    }
    if (cur) segments.push(cur);
    const kept = segments.filter(s => s[2] >= 2).map(([a, b, r]) => [a, b, round(r)] as [number, number, number]);
    if (kept.some(s => s[1] - s[0] >= ROD_LENGTH)) out.push({ axis: unit(k), centre: [0, 0, 0], segments: kept });
  }
  return out;
}
