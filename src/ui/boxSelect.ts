import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';

/**
 * Box select: the top-level item ids whose box centre (LDraw, as shown) projects inside a
 * screen rectangle (pixels in the canvas, any drag direction). Hidden items are skipped and
 * a submodel use counts once.
 */
export function boxSelect(
  items: readonly { key: string; box: Box }[],
  camera: THREE.Camera,
  rect: { x0: number; y0: number; x1: number; y1: number },
  size: { w: number; h: number },
  hidden: ReadonlySet<string>,
): string[] {
  const [xa, xb] = [Math.min(rect.x0, rect.x1), Math.max(rect.x0, rect.x1)];
  const [ya, yb] = [Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1)];
  const out = new Set<string>();
  const v = new THREE.Vector3();
  for (const { key, box } of items) {
    const id = key.split('/')[0];
    if (hidden.has(id) || out.has(id)) continue;
    // LDraw (Y down) → view (studs, Y up, Z flipped)
    v.set((box.min[0] + box.max[0]) / 40, -(box.min[1] + box.max[1]) / 40, -(box.min[2] + box.max[2]) / 40).project(camera);
    if (v.z < -1 || v.z > 1) continue;
    const x = ((v.x + 1) / 2) * size.w, y = ((1 - v.y) / 2) * size.h;
    if (x >= xa && x <= xb && y >= ya && y <= yb) out.add(id);
  }
  return [...out];
}
