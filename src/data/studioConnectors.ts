import type { StudConnector } from '../ldraw/connectors';
import type { Vec3 } from '../ldraw/parse';
import type { Snap } from '../ldraw/shadow';
import { STUDIO_CONNECTORS } from './studioConnectors.generated';

/**
 * BrickLink Studio's own connectivity (`ldraw/connectivity/*.conn`, imported by
 * scripts/import-studio-connectivity.ts), used the way this project uses its other outside
 * sources: only where neither the measured geometry nor the LDCad shadow pack has that
 * connection, and never for a code whose shape is unverified (see studioConnectivity.ts).
 *
 * LDCad stays primary and the measurement stays the fallback: a Studio connection within
 * `SAME` of one of those is dropped, so a part the project already understands is unchanged.
 */

/** A connection Studio records: a stud or an anti-stud, in part space (LDraw, Y down). */
export type StudioConnector = { gender: 'M' | 'F'; pos: Vec3; axis: Vec3 };

/** Two connectors this close, pointing the same way, are the same connection. */
const SAME = 1.5;
/** Every stud this project seats is 4 LDU tall and 6 LDU across. */
const STUD = { length: 4, radius: 6 };

const cache = new Map<string, StudioConnector[]>();

/** The usable connections Studio records for a part, or none. */
export function studioConnectors(part: string): StudioConnector[] {
  const id = part.toLowerCase().replace(/\.dat$/, '').split('/').pop() ?? '';
  const hit = cache.get(id);
  if (hit) return hit;
  const out: StudioConnector[] = [];
  for (const entry of (STUDIO_CONNECTORS[id] ?? '').split(';')) {
    const [gender, ...n] = entry.trim().split(/\s+/);
    if ((gender !== 'M' && gender !== 'F') || n.length !== 6) continue;
    out.push({ gender, pos: [+n[0], +n[1], +n[2]], axis: [+n[3], +n[4], +n[5]] });
  }
  cache.set(id, out);
  return out;
}

/** Whether a connector this project already has sits at `pos` pointing along `axis`. */
function known(
  pos: readonly number[],
  axis: readonly number[],
  existing: { snaps?: readonly Snap[]; studs?: readonly StudConnector[] },
): boolean {
  const near = (p: readonly number[]) => Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) < SAME;
  const along = (a: readonly number[]) => Math.abs(a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2]) > 0.999;
  for (const s of existing.snaps ?? []) if (near(s.start) && along(s.axis)) return true;
  for (const s of existing.studs ?? []) {
    if (!near(s.base)) continue;
    const d = [s.tip[0] - s.base[0], s.tip[1] - s.base[1], s.tip[2] - s.base[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    if (along([d[0] / l, d[1] / l, d[2] / l])) return true;
  }
  return false;
}

/**
 * Studio's connections as snaps, for the ones `existing` (the measured studs and the LDCad snaps
 * of the same part) does not already know. The snaps wear the shadow pack's shape, so seating,
 * the collision test and the build animation treat them like any other stud.
 *
 * An anti-stud that opens downwards (−Y) is left out: that is the underside, and `socketsOf` /
 * `localSockets` already derive one socket per stud cell there from the part's own body, so
 * Studio's grid adds nothing but a duplicate.
 */
export function studioSnapsFor(
  part: string,
  existing: { snaps?: readonly Snap[]; studs?: readonly StudConnector[] } = {},
): Snap[] {
  return studioConnectors(part)
    .filter((c) => !(c.gender === 'F' && c.axis[1] < -0.9) && !known(c.pos, c.axis, existing))
    .map((c) => ({
    kind: 'cyl',
    gender: c.gender,
    start: [...c.pos] as Vec3,
    axis: [...c.axis] as Vec3,
    length: STUD.length,
    radius: STUD.radius,
    // an anti-stud is modelled square, like the shadow pack's own underside sockets
    shapes: [c.gender === 'F' ? 'S' : 'R'],
    slide: false,
    source: 'studio',
  }));
}
