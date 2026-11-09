import * as THREE from 'three';
import type { CameraSettings } from './camera';
import type { Timeline } from './timeline';

/**
 * Turntable hero turn: the camera holds still and the finished model spins about its own
 * vertical axis, so the backdrop, lighting and shadows stay put. The turn matches the
 * camera orbit it replaces (same angle, direction and easing as `heroAround`).
 */
type Heroic = Pick<Timeline, 'buildEnd' | 'duration' | 'heroOrbit' | 'modelBox'>;

const smooth = (u: number) => { const k = Math.min(1, Math.max(0, u)); return k * k * (3 - 2 * k); };

/** The camera orbit angle (radians) the hero turn stands for at time `t`; 0 before the outro. */
export function heroSpinAngle(tl: Pick<Timeline, 'buildEnd' | 'duration' | 'heroOrbit'>, degrees: number, t: number): number {
  if (t < tl.buildEnd || !tl.heroOrbit) return 0;
  const u = Math.min(1, Math.max(0, (t - tl.buildEnd) / Math.max(1e-6, tl.duration - tl.buildEnd)));
  return degrees * (Math.PI / 180) * u * smooth((t - tl.buildEnd) / 0.6);
}

/** The model-space (LDU) rotation for angle `a` about the vertical line through the model's centre. */
export function spinMatrix(tl: Pick<Timeline, 'modelBox'>, a: number): THREE.Matrix4 {
  const b = tl.modelBox;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  return new THREE.Matrix4().makeTranslation(cx, 0, cz).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz));
}

/** `at` (a poseAt sampler) with the turntable spin applied; `at` itself when the turntable is off. */
export function withTurntable(
  tl: Heroic,
  camera: Pick<CameraSettings, 'heroOrbitDegrees'> & Partial<Pick<CameraSettings, 'heroTurntable'>>,
  t: number,
  at: (key: string) => THREE.Matrix4 | null,
): (key: string) => THREE.Matrix4 | null {
  if (!camera.heroTurntable) return at;
  const a = heroSpinAngle(tl, camera.heroOrbitDegrees ?? 120, t);
  if (a === 0) return at;
  const spin = spinMatrix(tl, a);
  return (key) => { const m = at(key); return m && spin.clone().multiply(m); };
}
