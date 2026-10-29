import * as THREE from 'three';
import type { ColorDef } from '../ldraw/colors';
import type { PartGeometry } from '../ldraw/geometry';
import type { Instance } from '../model/assemble';
import { edgeMaterialFor, materialFor, placeholderMaterial } from './materials';

/** World scale: 1 world unit = 1 stud (20 LDU), +Y up. */
export const LDU = 1 / 20;

const TINT = {
  none: new THREE.Color(1, 1, 1),
  select: new THREE.Color(0.55, 1.15, 1.7),
  warn: new THREE.Color(1.8, 0.45, 0.45),
};
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

let placeholderGeom: THREE.BufferGeometry | null = null;
function placeholderGeometry() {
  // matches the placeholder body box (0..20, 0..24, 0..20 LDU)
  return (placeholderGeom ??= new THREE.BoxGeometry(20, 24, 20).translate(10, 12, 10));
}

type Slot = { mesh: THREE.InstancedMesh; index: number };

/** Draws model instances with one InstancedMesh per (part, color, sub-geometry). */
export class BrickRenderer {
  readonly root = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  /** faint outline edges, one per (part, color) group, sharing that group's instance matrices */
  private edges: THREE.LineSegments[] = [];
  private edgesOn = true;
  private slots = new Map<string, Slot[]>();
  /** mesh → instance index → key, for picking */
  private keyAt = new Map<THREE.InstancedMesh, string[]>();
  private instances: Instance[] = [];
  private highlight = new Map<string, 'select' | 'warn'>();

  constructor(
    private geometryOf: (part: string) => PartGeometry | null,
    private colors: Map<number, ColorDef>,
  ) {
    this.root.rotation.x = Math.PI;
    this.root.scale.setScalar(LDU);
  }

  setInstances(list: Instance[]): void {
    this.clear();
    this.instances = list;
    const groups = new Map<string, Instance[]>();
    for (const i of list) {
      const k = `${i.placeholder ? '?' : i.part}|${i.color}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(i);
    }
    for (const [, group] of groups) {
      const first = group[0];
      const geo = first.placeholder ? null : this.geometryOf(first.part);
      const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
      if (!geo) parts.push({ geometry: placeholderGeometry(), material: placeholderMaterial() });
      else {
        const main = this.colors.get(first.color);
        if (geo.main) parts.push({ geometry: geo.main, material: materialFor(main, false) });
        if (geo.mainDoubleSided) parts.push({ geometry: geo.mainDoubleSided, material: materialFor(main, true) });
        for (const f of geo.fixed) parts.push({ geometry: f.geometry, material: materialFor(this.colors.get(f.color), f.doubleSided) });
      }
      let groupMesh: THREE.InstancedMesh | null = null;
      for (const p of parts) {
        const mesh = new THREE.InstancedMesh(p.geometry, p.material, group.length);
        // Instances travel far from their assembled positions. Three.js would
        // otherwise recalculate every moving mesh's bounding sphere on every
        // frame, which is expensive and can cull parts mid-flight.
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const keys: string[] = [];
        this.keyAt.set(mesh, keys);
        group.forEach((inst, index) => {
          keys[index] = inst.key;
          mesh.setMatrixAt(index, inst.world);
          mesh.setColorAt(index, TINT.none);
          let s = this.slots.get(inst.key);
          if (!s) this.slots.set(inst.key, (s = []));
          s.push({ mesh, index });
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.meshes.push(mesh);
        this.root.add(mesh);
        groupMesh ??= mesh;
      }
      if (geo?.edges && groupMesh) {
        // the same instance matrices as the bricks: hidden or flying bricks take their edges along
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', geo.edges.getAttribute('position'));
        g.setAttribute('instanceMatrix', groupMesh.instanceMatrix);
        g.instanceCount = group.length;
        const lines = new THREE.LineSegments(g, edgeMaterialFor(this.colors.get(first.color)));
        lines.frustumCulled = false;
        lines.visible = this.edgesOn;
        lines.renderOrder = 1;
        this.edges.push(lines);
        this.root.add(lines);
      }
    }
    this.applyHighlight();
  }

  setMatrices(get: (key: string) => THREE.Matrix4 | null): void {
    for (const [key, slots] of this.slots) {
      const m = get(key) ?? HIDDEN;
      for (const s of slots) s.mesh.setMatrixAt(s.index, m);
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      // picking recomputes it from the new matrices when needed
      mesh.boundingSphere = null;
    }
  }

  /** Rebuilds the meshes from fresh part geometry (stud logos switched), keeping the current pose. */
  refresh(): void {
    const pose = this.readMatrices();
    this.setInstances(this.instances);
    const rest = new Map(this.instances.map((i) => [i.key, i.world]));
    this.setMatrices((k) => (pose.has(k) ? pose.get(k) ?? HIDDEN : rest.get(k) ?? null));
  }

  /** Restores every instance to its assembled position. */
  resetMatrices(): void {
    const byKey = new Map(this.instances.map((i) => [i.key, i.world]));
    this.setMatrices((k) => byKey.get(k) ?? null);
  }

  /** The matrices currently on the GPU (null = hidden). Lets an offscreen still
   * replay exactly what the viewport is showing, whatever pose produced it. */
  readMatrices(): Map<string, THREE.Matrix4 | null> {
    const out = new Map<string, THREE.Matrix4 | null>();
    const m = new THREE.Matrix4();
    for (const [key, slots] of this.slots) {
      slots[0].mesh.getMatrixAt(slots[0].index, m);
      const hidden = m.elements.every((v, i) => v === HIDDEN.elements[i]);
      out.set(key, hidden ? null : m.clone());
    }
    return out;
  }

  setHighlight(keys: Set<string>, kind: 'select' | 'warn'): void {
    for (const [k, v] of [...this.highlight]) if (v === kind) this.highlight.delete(k);
    for (const k of keys) if (this.highlight.get(k) !== 'select') this.highlight.set(k, kind);
    this.applyHighlight();
  }

  private applyHighlight(): void {
    const touched = new Set<THREE.InstancedMesh>();
    for (const [key, slots] of this.slots) {
      const h = this.highlight.get(key);
      for (const s of slots) {
        s.mesh.setColorAt(s.index, h ? TINT[h] : TINT.none);
        touched.add(s.mesh);
      }
    }
    for (const m of touched) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  pick(raycaster: THREE.Raycaster): string | null {
    this.root.updateMatrixWorld(true);
    for (const m of this.meshes) if (!m.boundingSphere) m.computeBoundingSphere();
    const hits = raycaster.intersectObjects(this.meshes, false);
    for (const h of hits) {
      if (h.instanceId === undefined) continue;
      const key = this.keyAt.get(h.object as THREE.InstancedMesh)?.[h.instanceId];
      if (key) return key;
    }
    return null;
  }

  /** Shows or hides the faint outline edges. */
  setEdges(on: boolean): void {
    this.edgesOn = on;
    for (const l of this.edges) l.visible = on;
  }

  meshCount(): number {
    return this.meshes.length;
  }

  private clear(): void {
    for (const m of this.meshes) {
      this.root.remove(m);
      m.dispose();
    }
    this.meshes = [];
    for (const l of this.edges) {
      this.root.remove(l);
      l.geometry.dispose(); // only the wrapper: the position and matrix buffers belong to the part and its mesh
    }
    this.edges = [];
    this.slots.clear();
    this.keyAt.clear();
  }

  dispose(): void {
    this.clear();
  }
}
