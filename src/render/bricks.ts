import * as THREE from 'three';
import type { ColorDef } from '../ldraw/colors';
import type { PartGeometry } from '../ldraw/geometry';
import type { Instance } from '../model/assemble';
import { ensureGlassThickness } from './glassThickness';
import { brickHex, EDGE_OPACITY, edgeMaterialFor, materialFor, placeholderMaterial, wireMaterial } from './materials';
import type { Materials, Palette } from './looks';

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
  private edgeStyle = { color: null as string | null, opacity: EDGE_OPACITY, match: false, lightness: -0.35, palette: 'studio' as Palette };
  private edgeMaterials = new Map<number, THREE.LineBasicMaterial>();
  /** Outlines only, no solid faces: a see-through wireframe of the model. */
  private wireframeOn = false;
  /** The ink every wireframe line is drawn in, so it reads on any brick colour. */
  private wireInk = 0x2c3a35;
  private slots = new Map<string, Slot[]>();
  /** mesh → instance index → key, for picking */
  private keyAt = new Map<THREE.InstancedMesh, string[]>();
  /** bumped when the set of pieces changes / when any piece moves (consumers like the dome visibility rebuild or refit on these) */
  structureVersion = 0;
  poseVersion = 0;
  /** Selection tint and outlines redraw the editor without invalidating shadows. */
  appearanceVersion = 0;
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
    this.structureVersion++;
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
        if ((p.material as THREE.MeshPhysicalMaterial).transmission > 0) ensureGlassThickness(p.geometry);
        const mesh = new THREE.InstancedMesh(p.geometry, p.material, group.length);
        mesh.userData.brickColor = first.color;
        // Instances travel far from their assembled positions. Three.js would
        // otherwise recalculate every moving mesh's bounding sphere on every
        // frame, which is expensive and can cull parts mid-flight.
        mesh.frustumCulled = false;
        // clear parts cast no shadow: the shadow passes treat every caster as solid
        mesh.castShadow = !(p.material as THREE.Material).transparent && ((p.material as THREE.MeshPhysicalMaterial).transmission ?? 0) <= 0;
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
        const lines = new THREE.LineSegments(g, this.edgeMaterial(first.color));
        // the part's colour, kept so the wireframe can hand the line back when it ends
        lines.userData.edgeColor = first.color;
        lines.frustumCulled = false;
        lines.visible = this.edgesOn;
        lines.renderOrder = 1;
        this.edges.push(lines);
        this.root.add(lines);
      }
    }
    this.applyWireframe();
    this.applyHighlight();
  }

  setMatrices(get: (key: string) => THREE.Matrix4 | null): void {
    const touched = new Set<THREE.InstancedMesh>();
    for (const [key, slots] of this.slots) {
      const matrix = get(key) ?? HIDDEN;
      for (const slot of slots) {
        const values = slot.mesh.instanceMatrix.array, offset = slot.index * 16;
        // GPU matrices are float32. Compare at the same precision so replaying
        // a double-precision rest pose does not dirty identical buffers forever.
        if (!matrix.elements.some((value, i) => values[offset + i] !== Math.fround(value))) continue;
        slot.mesh.setMatrixAt(slot.index, matrix);
        touched.add(slot.mesh);
      }
    }
    if (touched.size) this.poseVersion++;
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
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
        const color = h ? TINT[h] : TINT.none, values = s.mesh.instanceColor?.array, offset = s.index * 3;
        if (values && values[offset] === Math.fround(color.r) && values[offset + 1] === Math.fround(color.g) && values[offset + 2] === Math.fround(color.b)) continue;
        s.mesh.setColorAt(s.index, color);
        touched.add(s.mesh);
      }
    }
    if (touched.size) this.appearanceVersion++;
    for (const m of touched) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /** The nearest brick under a ray and where the ray meets it (world), skipping keys `skip` rejects. */
  pickHit(raycaster: THREE.Raycaster, skip?: (key: string) => boolean): { key: string; point: THREE.Vector3 } | null {
    this.root.updateMatrixWorld(true);
    for (const m of this.meshes) if (!m.boundingSphere) m.computeBoundingSphere();
    for (const h of raycaster.intersectObjects(this.meshes, false)) {
      if (h.instanceId === undefined) continue;
      const key = this.keyAt.get(h.object as THREE.InstancedMesh)?.[h.instanceId];
      if (key && !skip?.(key)) return { key, point: h.point.clone() };
    }
    return null;
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
    if (this.edgesOn !== on) this.appearanceVersion++;
    this.edgesOn = on;
    this.applyWireframe();
  }

  /** Renderer-owned materials: changing preview outlines cannot recolour another studio/export. */
  setEdgeStyle(options: Partial<Pick<Materials, 'edgeColor' | 'edgeOpacity' | 'edgeMatch' | 'edgeLightness' | 'palette'>>): void {
    const next = { color: options.edgeColor ?? null, opacity: options.edgeOpacity ?? EDGE_OPACITY,
      match: options.edgeMatch ?? false, lightness: options.edgeLightness ?? -0.35, palette: options.palette ?? 'studio' };
    const changed = Object.keys(next).some(key => next[key as keyof typeof next] !== this.edgeStyle[key as keyof typeof next]);
    this.edgeStyle = next;
    if (changed || next.match) {
      for (const [code, material] of this.edgeMaterials) this.styleEdge(material, code);
      this.appearanceVersion++;
    }
  }

  private edgeMaterial(code: number): THREE.LineBasicMaterial {
    let material = this.edgeMaterials.get(code);
    if (!material) {
      material = edgeMaterialFor(this.colors.get(code)).clone();
      material.defines = { USE_INSTANCING: '' };
      this.styleEdge(material, code);
      this.edgeMaterials.set(code, material);
    }
    return material;
  }

  private styleEdge(material: THREE.LineBasicMaterial, code: number): void {
    const definition = this.colors.get(code), base = edgeMaterialFor(definition), style = this.edgeStyle;
    material.color.copy(base.color);
    if (style.match) {
      if (definition?.finish === 'trans') material.color.set(style.palette === 'studio' ? brickHex(definition) : definition.hex);
      else material.color.copy((materialFor(definition, false) as THREE.MeshPhysicalMaterial).color);
      if (style.lightness !== 0) {
        const hsl = material.color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
        hsl.l = style.lightness < 0 ? hsl.l * (1 + style.lightness) : hsl.l + (1 - hsl.l) * style.lightness;
        material.color.setHSL(hsl.h, hsl.s, hsl.l, THREE.SRGBColorSpace);
      }
    } else if (style.color) material.color.set(style.color);
    // Transparent bricks retain their softer outlines at the default opacity.
    material.opacity = style.opacity * base.opacity / EDGE_OPACITY;
  }

  /**
   * A wireframe view: the LDraw outlines drawn in one ink colour, with the solid faces
   * hidden. Picking still works — the ray caster does not skip invisible meshes.
   */
  setWireframe(on: boolean, ink?: number): void {
    if (on !== this.wireframeOn) this.poseVersion++;
    if (ink !== undefined && ink !== this.wireInk) this.appearanceVersion++;
    if (ink !== undefined) this.wireInk = ink;
    this.wireframeOn = on;
    this.applyWireframe();
  }

  wireframe(): boolean {
    return this.wireframeOn;
  }

  /** Puts the faces, edges and wireframe ink back in step with the two switches. */
  private applyWireframe(): void {
    for (const mesh of this.meshes) mesh.visible = !this.wireframeOn;
    for (const line of this.edges) {
      line.material = this.wireframeOn
        ? wireMaterial(this.wireInk)
        : this.edgeMaterial(line.userData.edgeColor as number);
      line.visible = this.wireframeOn || this.edgesOn;
    }
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
    for (const material of this.edgeMaterials.values()) material.dispose();
    this.edgeMaterials.clear();
    this.slots.clear();
    this.keyAt.clear();
  }

  dispose(): void {
    this.clear();
  }
}
