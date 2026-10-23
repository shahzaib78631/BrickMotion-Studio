import type { FlatPart } from './flatten';
import { normalizeName } from './parse';

/** The library part an embedded copy refers to: `<title> - <part>.dat` → `<part>`. */
export function embeddedPartId(name: string): string | null {
  const base = normalizeName(name).split('/').pop()!.replace(/\.dat$/, '').trim();
  const match = /^.+?\s+-\s+([a-z0-9_.-]+)$/.exec(base);
  return match ? match[1] : null;
}

type Geometry = { count: number; centre: [number, number, number]; area: number };

function geometry(part: FlatPart): Geometry {
  let count = 0;
  let area = 0;
  const sum = [0, 0, 0];
  for (const tris of [part.tris, part.doubleSided])
    for (const pts of tris.values())
      for (let i = 0; i + 8 < pts.length; i += 9) {
        const ax = pts[i], ay = pts[i + 1], az = pts[i + 2];
        const bx = pts[i + 3], by = pts[i + 4], bz = pts[i + 5];
        const cx = pts[i + 6], cy = pts[i + 7], cz = pts[i + 8];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
          sum[0] += x;
          sum[1] += y;
          sum[2] += z;
        }
        count++;
      }
  return count ? { count, centre: [sum[0] / (count * 3), sum[1] / (count * 3), sum[2] / (count * 3)], area } : { count, centre: [0, 0, 0], area };
}

const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/**
 * An embedded copy may re-use a library part's connectors only when its actual
 * geometry is the same part. A matching name is not evidence: authors rename
 * files freely, so compare the flattened triangles as well.
 */
export function sameGeometry(a: FlatPart, b: FlatPart, tolerance = 0.5): boolean {
  const ga = geometry(a), gb = geometry(b);
  if (!ga.count || !gb.count || ga.count !== gb.count) return false;
  if (!a.bodyBox || !b.bodyBox || !a.fullBox || !b.fullBox) return false;
  for (const box of ['bodyBox', 'fullBox'] as const)
    for (let k = 0; k < 3; k++)
      if (!close(a[box]!.min[k], b[box]!.min[k], tolerance) || !close(a[box]!.max[k], b[box]!.max[k], tolerance)) return false;
  for (let k = 0; k < 3; k++) if (!close(ga.centre[k], gb.centre[k], tolerance)) return false;
  return close(ga.area, gb.area, Math.max(1, ga.area * 0.01));
}
