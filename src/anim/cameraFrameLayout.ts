/** Fixed-camera photographic staging. Never moves the camera: it positions the
 * starting loose pieces *inside* its existing frustum, reserving the centre
 * for the finished model. The normal timeline floor-window system reuses the
 * visible space if all the pieces cannot coexist in one tight shot. */
import type { Box } from '../ldraw/flatten';
import type { FloorItem } from './floorLayout';
import type { FloorSides, FrameStagingCamera } from './pacing';

const STUD = 20;
const GAP = 0.75; // keep readable gaps between physical footprints, in studs
const SAFE = 0.87; // retain 87% of each frame dimension for shadows and crop tolerance

type Vec = readonly [number, number, number];
type Spot = { x: number; z: number; nx: number; ny: number };
export type CameraFrameResult = { pos: Map<string, { x: number; z: number }>; overflow: string[] };
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec): Vec => { const l = Math.hypot(...v); return l > 1e-8 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };

export function createFrameStagingSpace(shot: FrameStagingCamera, ground: number, box: Box, sides: FloorSides) {
  const p = shot.position;
  const f = unit(sub(shot.target, p));
  if (dot(f, f) < 0.5) throw new Error('Staging camera needs a look-at target different from its position.');
  const right = unit(cross(f, Math.abs(f[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
  const up = unit(cross(right, f));
  const tanY = Math.tan(shot.fov * Math.PI / 360);
  const tanX = tanY * shot.aspect;
  if (!(tanX > 0 && tanY > 0)) throw new Error('Staging camera needs a valid field of view and aspect ratio.');
  const crop = shot.crop;
  const rect = crop ? {
    x0: (crop.x + crop.width * (1 - SAFE) / 2) * 2 - 1,
    x1: (crop.x + crop.width * (1 + SAFE) / 2) * 2 - 1,
    y0: 1 - (crop.y + crop.height * (1 + SAFE) / 2) * 2,
    y1: 1 - (crop.y + crop.height * (1 - SAFE) / 2) * 2,
  } : { x0: -SAFE, x1: SAFE, y0: -SAFE, y1: SAFE };
  const wFrame = rect.x1 - rect.x0, hFrame = rect.y1 - rect.y0;
  const yFloor = -ground / STUD;
  // Reserve the completed model's real, centered footprint, with a physical
  // gap. Nothing is scaled or made to overlap the finished build.
  const cx0 = box.min[0] / STUD - 0.85, cx1 = box.max[0] / STUD + 0.85;
  const cz0 = box.min[2] / STUD - 0.85, cz1 = box.max[2] / STUD + 0.85;
  const centreX = (box.min[0] + box.max[0]) / (2 * STUD);
  const centreZ = (box.min[2] + box.max[2]) / (2 * STUD);

  /** Project world studs into image NDC, preserving real perspective and Y. */
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const q: Vec = [x - p[0], y - p[1], z - p[2]];
    const distance = dot(q, f);
    return [dot(q, right) / (distance * tanX), dot(q, up) / (distance * tanY), distance];
  };
  const spots: Spot[] = [];
  const seen = new Set<string>();
  // Place the shelf rows in image space, not world XZ. Even for tilted cameras,
  // this produces a balanced 9:16 photograph without changing the shot.
  for (let row = 0; row <= 88; row++) for (let col = 0; col <= 66; col++) {
    const nx = rect.x0 + wFrame * col / 66, ny = rect.y0 + hFrame * row / 88;
    const rayY = f[1] + nx * tanX * right[1] + ny * tanY * up[1];
    if (rayY >= -1e-6) continue; // a horizon ray never meets the ground
    const t = (yFloor - p[1]) / rayY;
    if (!(t > 0) || t > 4000) continue;
    const x = Math.round((p[0] + t * (f[0] + nx * tanX * right[0] + ny * tanY * up[0])) * 2) / 2;
    const z = Math.round(-(p[2] + t * (f[2] + nx * tanX * right[2] + ny * tanY * up[2])) * 2) / 2;
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spots.push({ x, z, nx: (nx - (rect.x0 + rect.x1) / 2) / wFrame, ny: (ny - (rect.y0 + rect.y1) / 2) / hFrame });
  }
  // Stable candidate order: the target grid below decides the composition,
  // and distance to that target chooses the best collision-free position.
  spots.sort((a, b) => a.ny - b.ny || a.nx - b.nx);

  const fits = (x: number, z: number, w: number, d: number, h: number): boolean => {
    if (x < cx1 && x + w > cx0 && z < cz1 && z + d > cz0) return false;
    const midX = x + w / 2, midZ = z + d / 2;
    if (sides === 'front' && midZ > centreZ) return false;
    if (sides === 'behind' && midZ < centreZ) return false;
    if (sides === 'sides' && Math.abs(midX - centreX) < Math.abs(midZ - centreZ)) return false;
    if (sides === 'front-back' && Math.abs(midX - centreX) > Math.abs(midZ - centreZ)) return false;
    for (const y of [yFloor, yFloor + h]) for (const xx of [x, x + w]) for (const zz of [z, z + d]) {
      const [nx, ny, depth] = project(xx, y, -zz);
      if (!Number.isFinite(nx) || !Number.isFinite(ny) ||
          depth < (shot.near ?? 0.05) || depth > (shot.far ?? 5000) ||
          nx < rect.x0 - 1e-5 || nx > rect.x1 + 1e-5 ||
          ny < rect.y0 - 1e-5 || ny > rect.y1 + 1e-5) return false;
    }
    return true;
  };

  return {
    place(items: FloorItem[]): CameraFrameResult {
      const pos = new Map<string, { x: number; z: number }>();
      const occupied: { x: number; z: number; w: number; d: number }[] = [];
      const sorted = items.map((item, i) => ({ item, i })).sort((a, b) =>
        a.item.group - b.item.group || b.item.w * b.item.d - a.item.w * a.item.d || a.i - b.i);
      // Unlike tight center-first packing, evenly distributed image-space
      // targets USE the camera frame. This is the crucial reference-photo
      // behavior: the camera stays fixed and the pieces spread to fill it.
      const columns = Math.max(1, Math.round(Math.sqrt(sorted.length * shot.aspect)));
      const rows = Math.ceil(sorted.length / columns);
      const fill = Math.min(0.40, 0.27 + 0.018 * Math.sqrt(sorted.length));
      for (let rank = 0; rank < sorted.length; rank++) {
        const { item } = sorted[rank];
        const row = Math.floor(rank / columns), col = rank % columns;
        const colsInRow = Math.min(columns, sorted.length - row * columns);
        const tx = colsInRow === 1 ? 0 : ((col / (colsInRow - 1)) * 2 - 1) * fill;
        const ty = rows === 1 ? 0 : (1 - row * 2 / (rows - 1)) * fill;
        let bestX = 0, bestZ = 0, score = Infinity;
        for (const spot of spots) {
          const dx = spot.nx - tx, dy = spot.ny - ty;
          const distance = dx * dx + dy * dy;
          if (distance >= score) continue;
          const x = spot.x - item.w / 2, z = spot.z - item.d / 2;
          if (!fits(x, z, item.w, item.d, item.h ?? 1)) continue;
          if (occupied.some((u) => x < u.x + u.w + GAP && x + item.w + GAP > u.x &&
                               z < u.z + u.d + GAP && z + item.d + GAP > u.z)) continue;
          bestX = x; bestZ = z; score = distance;
          if (score < 0.00001) break;
        }
        if (score < Infinity) {
          pos.set(item.id, { x: bestX, z: bestZ });
          occupied.push({ x: bestX, z: bestZ, w: item.w, d: item.d });
        }
      }
      return { pos, overflow: items.filter((it) => !pos.has(it.id)).map((it) => it.id) };
    },
    hasFootprint: spots.length > 0,
    /** Test projected 3D top and base bounds; useful for regression tests. */
    fits,
  };
}
