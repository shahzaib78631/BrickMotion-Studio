/** Measured per-part gear table (see gearGeometry.ts for sources). */
import * as THREE from 'three';
import { TOOTH_PITCH_RADIUS, type WorldGear } from './gearGeometry';

type V3 = [number, number, number];
type SpurEntry = { kind: 'spur'; teeth: number; width: number };
/** Bevel teeth on a 45 degree cone; `facing` is the side the teeth face, the
 * cone tip lies `apex` LDU from the part origin that way. */
type BevelEntry = { kind: 'bevel'; teeth: number; width: number; facing: 1 | -1; apex: number };
/** Rack pitch line: starts at `start`, runs `length` along +X, teeth face `face`. */
type RackEntry = { kind: 'rack'; teeth: number; length: number; width: number; start: V3; face: V3 };
type Entry = SpurEntry | BevelEntry | RackEntry;

// Gear axles run along the part's Z axis in LDraw (bevel facing is ±Z), as
// checked on LEGO 5590's steering bevels, whose cone tips meet within 2 LDU.
const TABLE: Record<string, Entry> = {
  '3647': { kind: 'spur', teeth: 8, width: 9.5 },
  '10928': { kind: 'spur', teeth: 8, width: 9.5 },
  '4019': { kind: 'spur', teeth: 16, width: 9.5 },
  '94925': { kind: 'spur', teeth: 16, width: 9.5 },
  '3648': { kind: 'spur', teeth: 24, width: 9.5 },
  '3648a': { kind: 'spur', teeth: 24, width: 9.5 },
  '3648b': { kind: 'spur', teeth: 24, width: 9.5 },
  '3649': { kind: 'spur', teeth: 40, width: 9.5 },
  // Old differential's 14T bevel: teeth face -Z, cone tip 17 LDU out.
  '4143': { kind: 'bevel', teeth: 14, width: 4, facing: -1, apex: 17 },
  // 20T bevel, older type: teeth face -Z, tip 28 LDU out.
  '32198': { kind: 'bevel', teeth: 20, width: 7, facing: -1, apex: 28 },
  '32198a': { kind: 'bevel', teeth: 20, width: 7, facing: -1, apex: 28 },
  '87407': { kind: 'bevel', teeth: 20, width: 8, facing: -1, apex: 30 },
  // Rack 1x4: ten teeth, pitch line 4 LDU above its top (LDraw -Y is up).
  '3743': { kind: 'rack', teeth: 10, length: 80, width: 20, start: [-40, -4, 0], face: [0, -1, 0] },
};

const bare = (part: string) => part.toLowerCase().replace(/\.dat$/, '').replace(/^.*[\\/]/, '');
export const hasMeasuredGear = (part: string) => bare(part) in TABLE;

export function worldGear(key: string, part: string, world: THREE.Matrix4): WorldGear | null {
  const e = TABLE[bare(part)];
  if (!e) return null;
  const point = (p: V3) => new THREE.Vector3(...p).applyMatrix4(world).toArray() as V3;
  const dir = (d: V3) => new THREE.Vector3(...d).transformDirection(world).toArray() as V3;
  if (e.kind === 'rack') {
    const direction = dir([1, 0, 0]);
    const start = point(e.start);
    return { key, kind: 'rack', teeth: e.teeth, width: e.width, length: e.length,
      centre: start.map((x, i) => x + direction[i] * e.length / 2) as V3, direction, face: dir(e.face) };
  }
  const centre = point([0, 0, 0]), axis = dir([0, 0, 1]);
  const radius = TOOTH_PITCH_RADIUS * e.teeth;
  if (e.kind === 'spur') return { key, kind: 'spur', teeth: e.teeth, radius, width: e.width, centre, axis };
  const facing = dir([0, 0, e.facing]);
  return { key, kind: 'bevel', teeth: e.teeth, radius, width: e.width, centre, axis, facing,
    tip: centre.map((x, i) => x + facing[i] * e.apex) as V3 };
}

