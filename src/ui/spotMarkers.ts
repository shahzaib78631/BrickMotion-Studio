import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import { facing, outline, sameSpot, type SpotRef } from '../plan/assemblySpots';

/** One floor marker: the model's footprint at its spot, its facing arrow and its name. */
export type SpotMarkerInfo = {
  ref: SpotRef;
  label: string;
  /** the assembled bounding box in the set's own frame (LDU) */
  raw: Box;
  /** footprint centre in LDU */
  centre: [number, number];
  angle: number;
  placed: boolean;
};

const PLACED = 0x2f6f68;
const AUTO = 0x9aa0a8;
const SELECTED = 0x2f6fe0;
const LIFT = 0.06; // world units above the floor, so it never z-fights the bricks

const toWorld = ([x, z]: [number, number], floorY: number) => new THREE.Vector3(x / 20, floorY + LIFT, -z / 20);

function labelSprite(text: string, color: number): THREE.Sprite {
  const scale = 2;
  const font = `600 ${11 * scale}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const pad = 8 * scale;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = 22 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const r = h / 2;
  ctx.fillStyle = 'rgba(20, 22, 26, 0.82)';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2 + scale);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, sizeAttenuation: true }));
  sprite.scale.set((w / h) * 0.34, 0.34, 1);
  return sprite;
}

/**
 * The floor markers of the Assembly tab, drawn only in the Build view. Each marker is
 * pickable (its invisible footprint plate carries the tile's `SpotRef`).
 */
export class SpotMarkers {
  readonly group = new THREE.Group();
  private items: { hit: THREE.Object3D; ref: SpotRef }[] = [];
  private trash: { dispose(): void }[] = [];
  private floorY = 0;

  constructor() {
    this.group.name = 'assembly-spots';
    this.group.renderOrder = 5;
  }

  pick(raycaster: THREE.Raycaster): SpotRef | null {
    const hit = raycaster.intersectObjects(this.items.map((i) => i.hit), false)[0];
    const ref = hit?.object.userData.ref as SpotRef | undefined;
    return ref ? { model: ref.model, id: ref.id } : null;
  }

  update(list: SpotMarkerInfo[], selected: SpotRef | null, floorY = 0): void {
    this.floorY = floorY;
    this.clear();
    for (const m of list) this.add(m, sameSpot(selected, m.ref));
  }

  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const d of this.trash) d.dispose();
    this.trash = [];
    this.items = [];
  }

  dispose(): void {
    this.clear();
  }

  private add(m: SpotMarkerInfo, selected: boolean): void {
    const color = m.placed ? (selected ? SELECTED : PLACED) : AUTO;
    const opacity = m.placed ? (selected ? 1 : 0.92) : 0.4;
    const corners = outline(m.raw, m.centre[0], m.centre[1], m.angle).map((pt) => toWorld(pt, this.floorY));
    const centre = toWorld(m.centre, this.floorY);

    const lineGeom = new THREE.BufferGeometry().setFromPoints(corners);
    const lineMat = m.placed
      ? new THREE.LineBasicMaterial({ color, transparent: true, opacity })
      : new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.35, gapSize: 0.28 });
    const loop = new THREE.LineLoop(lineGeom, lineMat);
    if (!m.placed) loop.computeLineDistances();
    this.group.add(loop);
    this.trash.push(lineGeom, lineMat);

    if (m.placed) {
      const [fx, fz] = facing(m.angle); // plan (x, z); world z is the plan's −z
      const forward = new THREE.Vector3(fx, 0, -fz);
      const perp = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const size = Math.max(...corners.map((c) => c.distanceTo(centre)));
      const tip = centre.clone().addScaledVector(forward, size + 0.05);
      const a = tip.clone().addScaledVector(forward, -0.34).addScaledVector(perp, 0.22);
      const b = tip.clone().addScaledVector(forward, -0.34).addScaledVector(perp, -0.22);
      const arrowGeom = new THREE.BufferGeometry().setFromPoints([tip, a, tip, b]);
      const arrowMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      this.group.add(new THREE.LineSegments(arrowGeom, arrowMat));
      this.trash.push(arrowGeom, arrowMat);
    }

    const sprite = labelSprite(m.label, color);
    sprite.position.copy(centre).setY(this.floorY + 0.52);
    this.group.add(sprite);
    const spriteMat = sprite.material as THREE.SpriteMaterial;
    this.trash.push(spriteMat);
    if (spriteMat.map) this.trash.push(spriteMat.map);

    // Pick only the perimeter and the centre grip, not an invisible solid
    // plate covering the entire model. Otherwise a spot makes every brick
    // inside its footprint impossible to select with the mouse.
    const hitGeom = new THREE.BufferGeometry();
    const triangles: number[] = [];
    const strip = (a: THREE.Vector3, b: THREE.Vector3, halfWidth: number) => {
      const side = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(halfWidth);
      const p = a.clone().add(side), q = a.clone().sub(side),
        r = b.clone().sub(side), t = b.clone().add(side);
      for (const v of [p, q, r, p, r, t]) triangles.push(v.x, v.y, v.z);
    };
    for (let i = 0; i < corners.length; i++) strip(corners[i], corners[(i + 1) % corners.length], 0.105);
    const size = 0.28;
    const a = centre.clone().add(new THREE.Vector3(-size, 0, -size));
    const b = centre.clone().add(new THREE.Vector3(size, 0, -size));
    const c = centre.clone().add(new THREE.Vector3(size, 0, size));
    const d = centre.clone().add(new THREE.Vector3(-size, 0, size));
    for (const v of [a, b, c, a, c, d]) triangles.push(v.x, v.y, v.z);
    hitGeom.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const hit = new THREE.Mesh(hitGeom, hitMat);
    hit.userData.ref = m.ref;
    this.group.add(hit);
    this.trash.push(hitGeom, hitMat);
    this.items.push({ hit, ref: m.ref });
  }
}
