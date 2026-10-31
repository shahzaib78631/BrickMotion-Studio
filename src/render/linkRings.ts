import * as THREE from 'three';
import type { Vec3 } from '../ldraw/parse';

/** Ring size in view units (studs): just round a stud (radius 7 LDU). */
const RADIUS = 0.35;
const TUBE = 0.06;
/** The app's focus colour (the UI accent is greyscale, which disappears against bricks). */
const COLOR = 0x6366f1;

/**
 * Small rings on the connections a placing pose will make, drawn over everything so they
 * show through the piece being placed. Editor scene only.
 */
export class LinkRings {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.TorusGeometry(RADIUS, TUBE, 8, 24);
  private readonly material = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });

  constructor(private readonly scene: THREE.Object3D) {
    this.group.name = 'link-rings';
    this.group.renderOrder = 999;
    scene.add(this.group);
  }

  /** One ring per link (LDraw LDU), mapped into the view by `toView`, its face square to the link axis. */
  show(links: readonly { pos: Vec3; axis: Vec3 }[], toView: THREE.Matrix4): void {
    while (this.group.children.length < links.length) {
      const ring = new THREE.Mesh(this.geometry, this.material);
      ring.renderOrder = 999;
      this.group.add(ring);
    }
    const normal = new THREE.Matrix3().getNormalMatrix(toView);
    const z = new THREE.Vector3(0, 0, 1);
    this.group.children.forEach((ring, i) => {
      const link = links[i];
      ring.visible = !!link;
      if (!link) return;
      ring.position.set(...link.pos).applyMatrix4(toView);
      const axis = new THREE.Vector3(...link.axis).applyMatrix3(normal).normalize();
      ring.quaternion.setFromUnitVectors(z, axis);
    });
  }

  clear(): void {
    for (const ring of this.group.children) ring.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
