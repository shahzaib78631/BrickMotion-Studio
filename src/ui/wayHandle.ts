import * as THREE from 'three';
import type { Way } from '../anim/flightDirection';

/** LDraw (−Y up, LDU) → view (Y up, 1/20 scale); see modelPlacement.ts */
export const ldrawToView = (w: readonly number[]): THREE.Vector3 => new THREE.Vector3(w[0], -w[1], -w[2]);
export const viewToLdraw = (v: THREE.Vector3): Way => [v.x + 0, -v.y + 0, -v.z + 0];

const COLOR = 0xff7a1a;

/**
 * The editor's "flies in from" handle: an arrow from the selected piece's centre
 * out along the way it comes in from, with a grab ball at its tip. Drawn on top of
 * the bricks so it is never hidden inside the model. Editor scene only.
 */
export class WayHandle {
  readonly group = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly cone: THREE.Mesh;
  private readonly tip: THREE.Mesh;
  private readonly trail: THREE.Line;
  /** the arrow's base in view coordinates */
  readonly center = new THREE.Vector3();
  length = 3;

  constructor() {
    this.group.name = 'flight-way-handle';
    this.group.renderOrder = 10;
    const material = (opacity: number) => new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, depthWrite: false, transparent: true, opacity });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10), material(0.9));
    this.cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 16), material(0.95));
    this.tip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), material(0.55));
    // the flight comes in along the arrow: a dashed line past the tip shows where it starts
    this.trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineDashedMaterial({ color: COLOR, dashSize: 0.25, gapSize: 0.18, depthTest: false, transparent: true, opacity: 0.6 }));
    for (const m of [this.shaft, this.cone, this.tip, this.trail]) { m.renderOrder = 10; this.group.add(m); }
    this.group.visible = false;
  }

  /** Places the arrow at `center` (view) pointing along `dir` (view, any length). */
  set(center: THREE.Vector3, dir: THREE.Vector3, length = this.length): void {
    this.center.copy(center);
    this.length = length;
    this.point(dir);
    this.group.visible = true;
  }

  /** Turns the arrow to `dir` (view), keeping its base and length. */
  point(dir: THREE.Vector3): void {
    const d = dir.clone().normalize();
    if (d.lengthSq() < 0.5) return;
    this.group.position.copy(this.center);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const L = this.length;
    this.shaft.scale.set(1, L - 0.5, 1);
    this.shaft.position.set(0, (L - 0.5) / 2, 0);
    this.cone.position.set(0, L - 0.25, 0);
    this.tip.position.set(0, L + 0.35, 0);
    this.trail.scale.set(1, L * 1.6, 1);
    this.trail.position.set(0, L + 0.6, 0);
    this.trail.computeLineDistances();
  }

  hide(): void { this.group.visible = false; }

  /** Whether the pointer ray is on the arrow (tip, head or shaft). */
  pick(raycaster: THREE.Raycaster): boolean {
    if (!this.group.visible) return false;
    return raycaster.intersectObjects([this.tip, this.cone, this.shaft], false).length > 0;
  }

  /**
   * The direction (view) from the base toward where the pointer ray meets the sphere
   * the tip moves on; the nearest point of the ray when it misses.
   */
  aimAt(ray: THREE.Ray, current?: THREE.Vector3): THREE.Vector3 {
    const radius = this.length + 0.35;
    // both crossings of the sphere: keep the one nearer the current tip, so the tip
    // can be dragged round behind the piece without flipping to the front
    const oc = ray.origin.clone().sub(this.center);
    const b = oc.dot(ray.direction), c = oc.lengthSq() - radius * radius, disc = b * b - c;
    let p: THREE.Vector3;
    if (disc >= 0) {
      const near = ray.at(-b - Math.sqrt(disc), new THREE.Vector3()), far = ray.at(-b + Math.sqrt(disc), new THREE.Vector3());
      const tip = current ? this.center.clone().addScaledVector(current.clone().normalize(), radius) : null;
      p = tip && far.distanceTo(tip) < near.distanceTo(tip) ? far : near;
    } else p = ray.closestPointToPoint(this.center, new THREE.Vector3());
    return p.sub(this.center).normalize();
  }

  dispose(): void {
    for (const m of [this.shaft, this.cone, this.tip, this.trail]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
