import * as THREE from 'three';

export type BookletCamera = {
  yaw: number; pitch: number; roll: number; scale: number;
  cx: number; cy: number; up: 1 | -1; persp: number; offsets: number[][];
};

/** Pixel coordinates use a top-left origin; LDraw uses -Y as up. */
export function bookletCamera(c: BookletCamera, centre: THREE.Vector3, radius: number, W: number, H: number) {
  const yaw = THREE.MathUtils.degToRad(c.yaw), pitch = THREE.MathUtils.degToRad(c.pitch);
  const dir = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
  const dist = Math.max(radius, 1) * (c.persp > 0 ? c.persp : 4);
  const halfW = W / (2 * c.scale), halfH = H / (2 * c.scale);
  const sx = (W / 2 - c.cx) / c.scale, sy = (c.cy - H / 2) / c.scale;
  let cam: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  if (c.persp > 0) {
    cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(halfH / dist)), W / H, dist * 0.01, dist * 4);
    cam.setViewOffset(W, H, sx * c.scale, -sy * c.scale, W, H);
  } else {
    cam = new THREE.OrthographicCamera(-halfW + sx, halfW + sx, halfH + sy, -halfH + sy, 0.1, dist * 3);
  }
  cam.position.copy(centre).addScaledVector(dir, dist);
  cam.up.set(0, -c.up, 0);
  cam.lookAt(centre);
  cam.rotateZ(THREE.MathUtils.degToRad(c.roll));
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

/** Minimum-depth displacement explaining an image-space explosion. Depth is unobservable in an orthographic image. */
export function screenOffset(cam: THREE.Camera, scale: number, dx: number, dy: number, turned: boolean): number[] {
  const v = new THREE.Vector3(dx / scale, -dy / scale, 0).applyQuaternion(cam.quaternion);
  if (turned) v.applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  return v.toArray();
}

/** `persp` (eye distance in model radii) for an eye at a fixed distance in LDU. A booklet keeps one camera, so the
 * eye distance is the same for every step, while each step's model radius differs. 0 = orthographic. */
export function perspectiveRadii(distanceLdu: number, radius: number) {
  return distanceLdu > 0 ? distanceLdu / Math.max(radius, 1) : 0;
}

/** Keep the same printed scale when crops have different raster resolutions. */
export function rasterScale(referenceScale: number, referencePtsPerPx?: number, ptsPerPx?: number) {
  return referencePtsPerPx && ptsPerPx ? referenceScale * referencePtsPerPx / ptsPerPx : referenceScale;
}
