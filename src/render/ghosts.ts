import * as THREE from 'three';
import type { ColorDef } from '../ldraw/colors';
import type { PartGeometry } from '../ldraw/geometry';
import type { Ghost } from '../suggest/engine';

/**
 * Suggested next pieces, drawn see-through in their own colour with an accent outline.
 * Editor scene only: never in previews or exports.
 */
const ACCENT = 0x6366f1;

export class GhostPieces {
  readonly group = new THREE.Group();
  private readonly materials = new Map<number, THREE.Material>();
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthTest: false });
  private shown = '';

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly geometryOf: (part: string) => PartGeometry | null,
    private readonly colors: () => Map<number, ColorDef>,
  ) {
    this.group.name = 'suggestion-ghosts';
    this.group.renderOrder = 998;
    scene.add(this.group);
  }

  private material(color: number): THREE.Material {
    let m = this.materials.get(color);
    if (!m) {
      const hex = this.colors().get(color)?.hex ?? '#9ca3af';
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.4, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0.12 });
      this.materials.set(color, m);
    }
    return m;
  }

  /** Draw `pieces` (model LDU, column-major) mapped into the view by `toView`. */
  show(pieces: readonly Ghost[], toView: THREE.Matrix4): void {
    const key = JSON.stringify(pieces) + toView.elements.join();
    if (key === this.shown) return;
    this.clear();
    this.shown = key;
    for (const g of pieces) {
      const geo = this.geometryOf(g.part);
      if (!geo) continue;
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(toView).multiply(new THREE.Matrix4().fromArray(g.world));
      for (const geometry of [geo.main, geo.mainDoubleSided, ...geo.fixed.map((f) => f.geometry)]) {
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, this.material(g.color));
        mesh.renderOrder = 998;
        holder.add(mesh);
      }
      if (geo.edges) {
        const lines = new THREE.LineSegments(geo.edges, this.edgeMaterial);
        lines.renderOrder = 999;
        holder.add(lines);
      }
      this.group.add(holder);
    }
  }

  clear(): void {
    this.shown = '';
    // geometries belong to the part cache: only drop the objects
    this.group.clear();
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const m of this.materials.values()) m.dispose();
    this.edgeMaterial.dispose();
  }
}
