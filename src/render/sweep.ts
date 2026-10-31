/**
 * A curved studio sweep (an "infinity cove"): a flat floor that bends up in one smooth
 * curve into a tall back wall, like the paper roll behind a product shot. There is no
 * corner or horizon line, so the model sits in an endless soft backdrop.
 *
 * The sweep turns about the model to stay behind it as the camera orbits (as a
 * photographer would move the paper), and it is lit and catches the real shadows.
 */
import * as THREE from 'three';

export type SweepShape = {
  /** floor in front of the model's centre (toward the camera) */
  front: number;
  /** from the model's centre to the back wall */
  back: number;
  /** radius of the curve between floor and wall */
  curve: number;
  /** wall height above the floor */
  height: number;
  /** full width across */
  width: number;
};

/**
 * A sweep sized for a model of bounding radius `r` (world units). `softness` 0 is a
 * tight bend close to the wall, 1 a long curve that starts right behind the model.
 */
export function sweepFor(r: number, softness = 0.6): SweepShape {
  const radius = Math.max(4, r);
  const back = radius * 1.9;
  const soft = Math.min(1, Math.max(0, softness));
  return { front: radius * 40, back, curve: back * (0.25 + 0.75 * soft), height: radius * 40, width: radius * 90 };
}

/** The profile from the front edge, along the floor, round the curve and up the wall: (z, y) points. */
export function sweepProfile(s: SweepShape, curveSteps = 28): [number, number][] {
  const start = -(s.back - s.curve);
  const pts: [number, number][] = [[s.front, 0], [s.front * 0.25, 0], [start * 0.5, 0], [start, 0]];
  for (let i = 1; i <= curveSteps; i++) {
    const t = (i / curveSteps) * (Math.PI / 2);
    pts.push([start - s.curve * Math.sin(t), s.curve - s.curve * Math.cos(t)]);
  }
  pts.push([-s.back, Math.max(s.curve, s.height * 0.3)], [-s.back, s.height]);
  return pts;
}

/** The sweep as a mesh-ready geometry: the model's centre at the origin, the wall toward −Z, the floor at y = 0. */
export function sweepGeometry(s: SweepShape): THREE.BufferGeometry {
  const profile = sweepProfile(s);
  const across = [-0.5, -0.15, 0, 0.15, 0.5].map((f) => f * s.width);
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    for (let j = 0; j < across.length; j++) {
      positions.push(across[j], profile[i][1], profile[i][0]);
      uvs.push(j / (across.length - 1), i / (profile.length - 1));
    }
  }
  const row = across.length;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < row - 1; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      // facing up on the floor and toward +Z (the model) on the wall
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Rotation about Y that puts the sweep's wall on the far side of `center` from the camera. */
export function sweepFacing(center: THREE.Vector3, camera: THREE.Vector3): number {
  const dx = camera.x - center.x, dz = camera.z - center.z;
  return Math.hypot(dx, dz) < 1e-6 ? 0 : Math.atan2(dx, dz);
}

export class Sweep {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private center = new THREE.Vector3();
  private radius = 0;
  private softness = 0.6;
  private built = '';

  constructor() {
    const material = new THREE.MeshStandardMaterial({ color: '#d9d9d6', roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.Mesh(sweepGeometry(sweepFor(8)), material);
    this.mesh.name = 'studio-sweep';
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -3;
    this.mesh.visible = false;
  }

  /** Sizes the sweep for the model in `box` and stands it on the floor at `groundY`. */
  fit(box: THREE.Box3, groundY: number): void {
    const r = Math.max(4, box.getSize(new THREE.Vector3()).length() / 2);
    box.getCenter(this.center);
    this.center.y = groundY - 0.001;
    this.mesh.position.copy(this.center);
    this.radius = r;
    this.rebuild();
  }

  /** How big the bend is: 0 tight, 1 long and soft. */
  setCurve(softness: number): void {
    this.softness = softness;
    this.rebuild();
  }

  private rebuild() {
    const id = `${this.radius.toFixed(3)}|${this.softness.toFixed(3)}`;
    if (id === this.built || !this.radius) return;
    this.built = id;
    this.mesh.geometry.dispose();
    this.mesh.geometry = sweepGeometry(sweepFor(this.radius, this.softness));
  }

  /** How far behind the model the wall stands (for shadow framing). */
  get reach(): number { return sweepFor(this.radius || 8, this.softness).back; }

  /** Turns the sweep so its wall is behind the model as seen from `camera`. */
  face(camera: THREE.Camera): void {
    if (!this.mesh.visible) return;
    this.mesh.rotation.y = sweepFacing(this.center, camera.getWorldPosition(new THREE.Vector3()));
    this.mesh.updateMatrixWorld();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
