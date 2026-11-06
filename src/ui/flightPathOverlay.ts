import * as THREE from 'three';
import type { FlightPath } from '../anim/flightPath';

const PATH = 0x3aa7ff;
const HIT = 0xff3b30;
const KEY = 0xffffff;
const CURRENT = 0xffb020;
const DOT = 0.16;

/**
 * The selected piece's flight path in the editor viewport: a line through every frame of
 * its flight, red where it goes through a built piece, and a dot on each keyframe (the one
 * at the playhead larger, in orange). Drawn over the bricks so it is never hidden inside the
 * model. Editor scene only; never in preview or export.
 */
export class FlightPathOverlay {
  readonly group = new THREE.Group();
  private readonly line: THREE.Line;
  private readonly hit: THREE.LineSegments;
  private readonly dotGeometry = new THREE.SphereGeometry(DOT, 14, 10);
  private readonly dotMaterial = new THREE.MeshBasicMaterial({ color: KEY, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  private readonly currentMaterial = new THREE.MeshBasicMaterial({ color: CURRENT, depthTest: false, depthWrite: false, transparent: true });
  private dots: THREE.Mesh[] = [];
  private path: FlightPath | null = null;

  constructor() {
    this.group.name = 'flight-path';
    this.group.renderOrder = 11;
    this.line = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: PATH, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
    this.hit = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: HIT, depthTest: false, depthWrite: false, transparent: true }));
    this.line.renderOrder = 11;
    this.hit.renderOrder = 12;
    this.group.add(this.line, this.hit);
    this.group.visible = false;
  }

  /** Draws `path`; `hits` are frames inside another piece, `frame` the playhead. */
  set(path: FlightPath, hits: ReadonlySet<number>, frame: number): void {
    this.path = path;
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(path.samples.map((s) => s.at));
    this.setHits(hits);
    for (const dot of this.dots) this.group.remove(dot);
    this.dots = path.keys.map((key) => {
      const dot = new THREE.Mesh(this.dotGeometry, key.frame === frame ? this.currentMaterial : this.dotMaterial);
      dot.position.copy(key.at);
      if (key.frame === frame) dot.scale.setScalar(1.5);
      dot.renderOrder = 13;
      dot.userData.frame = key.frame;
      this.group.add(dot);
      return dot;
    });
    this.group.visible = true;
  }

  /** Red over each sample step that ends inside another piece. */
  setHits(hits: ReadonlySet<number>): void {
    const points: THREE.Vector3[] = [];
    const s = this.path?.samples ?? [];
    for (let i = 1; i < s.length; i++) if (hits.has(s[i].frame) || hits.has(s[i - 1].frame)) points.push(s[i - 1].at, s[i].at);
    this.hit.geometry.dispose();
    this.hit.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  hide(): void {
    this.group.visible = false;
    this.path = null;
  }

  get shown(): boolean { return this.group.visible && !!this.path; }

  /** The keyframe whose dot the ray is on. */
  pickKey(raycaster: THREE.Raycaster): number | null {
    if (!this.shown) return null;
    const hit = raycaster.intersectObjects(this.dots, false)[0];
    return hit ? hit.object.userData.frame as number : null;
  }

  /**
   * The frame on the path nearest the ray, when the ray passes within `slack` studs of the
   * line (for adding a point there).
   */
  pickLine(ray: THREE.Ray, slack = 0.35): number | null {
    const s = this.path?.samples;
    if (!this.shown || !s || s.length < 2) return null;
    let best: { frame: number; d: number } | null = null;
    const onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (let i = 1; i < s.length; i++) {
      const d2 = ray.distanceSqToSegment(s[i - 1].at, s[i].at, onRay, onSeg);
      if (d2 > slack * slack || (best && d2 >= best.d)) continue;
      const len = s[i - 1].at.distanceTo(s[i].at);
      const t = len > 1e-9 ? onSeg.distanceTo(s[i - 1].at) / len : 0;
      best = { frame: Math.round(s[i - 1].frame + t * (s[i].frame - s[i - 1].frame)), d: d2 };
    }
    return best?.frame ?? null;
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.hit.geometry.dispose();
    (this.hit.material as THREE.Material).dispose();
    this.dotGeometry.dispose();
    this.dotMaterial.dispose();
    this.currentMaterial.dispose();
  }
}
