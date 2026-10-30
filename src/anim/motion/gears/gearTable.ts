/**
 * Placed gears and racks. Their geometry is measured from each part's LDraw
 * shape (parts/teeth.ts, cached in parts/partFunctions.ts); this places the
 * features with an instance's world matrix.
 */
import * as THREE from 'three';
import type { WorldGear } from './gearGeometry';
import { partFunctions } from '../parts/partFunctions';
import type { ToothedFeature } from '../parts/teeth';

type V3 = [number, number, number];
/** A toothed feature in world space, on instance `key`. */
export type WorldFeature = ToothedFeature & { key: string };

export const hasMeasuredGear = (part: string) => (partFunctions(part)?.teeth.length ?? 0) > 0;

export function worldFeatures(key: string, part: string, world: THREE.Matrix4): WorldFeature[] {
  const teeth = partFunctions(part)?.teeth ?? [];
  if (!teeth.length) return [];
  const point = (p: V3) => new THREE.Vector3(...p).applyMatrix4(world).toArray() as V3;
  const dir = (d: V3) => new THREE.Vector3(...d).transformDirection(world).toArray() as V3;
  return teeth.map(f => ({
    ...f, key, axis: dir(f.axis), centre: point(f.centre),
    ...(f.facing ? { facing: dir(f.facing) } : {}), ...(f.tip ? { tip: point(f.tip) } : {}),
    ...(f.tips ? { tips: [point(f.tips[0]), point(f.tips[1])] as [V3, V3] } : {}),
    ...(f.face ? { face: dir(f.face) } : {}),
  }));
}

/**
 * The part's main gear or rack in the form the mesh tests take. A double
 * bevel is given as a spur (it meshes side by side); its bevel sides are in
 * worldFeatures.
 */
export function worldGear(key: string, part: string, world: THREE.Matrix4): WorldGear | null {
  const f = worldFeatures(key, part, world).find(x => x.kind !== 'worm');
  if (!f) return null;
  if (f.kind === 'rack') return { key, kind: 'rack', teeth: f.teeth, width: f.width, length: f.length!, centre: f.centre, direction: f.axis, face: f.face! };
  const base = { key, teeth: f.teeth, radius: f.pitchRadius, width: f.width, centre: f.centre, axis: f.axis };
  return f.kind === 'bevel' ? { ...base, kind: 'bevel', facing: f.facing, tip: f.tip } : { ...base, kind: 'spur' };
}
