/**
 * Reference images: pictures (a photo, a render, a sketch) hung in the 3D scene as flat
 * panels to model against. Editor-only: they are never in a preview, capture or video.
 * Coordinates are Three.js world studs; rotation is XYZ Euler degrees; `width` is the
 * panel's width in studs (its height follows the picture's shape).
 */
import * as THREE from 'three';
import { freshSceneId, type SceneSetup, type XYZ } from './sceneSetup';

export type ReferenceImage = {
  id: string;
  name: string;
  /** the picture itself, as a data: URL (kept with the project) */
  src: string;
  /** width ÷ height */
  aspect: number;
  position: XYZ;
  rotation: XYZ;
  width: number;
  /** 0 (invisible) … 1 (solid) */
  opacity: number;
  visible: boolean;
  /** a locked image cannot be picked or dragged in the viewport */
  locked: boolean;
};

export const MAX_REFERENCE_IMAGES = 16;
/** the longest side a stored picture keeps, in pixels */
export const REFERENCE_MAX_PIXELS = 2048;
export const MAX_REFERENCE_SRC = 8_000_000;

export const imagesOf = (setup?: SceneSetup): ReferenceImage[] => setup?.images ?? [];
export const referenceImage = (setup: SceneSetup | undefined, id: string | null): ReferenceImage | null =>
  imagesOf(setup).find((i) => i.id === id) ?? null;

/** A new image hung at `target`, facing a camera at `from`, as wide as a good share of the view. */
export function createReferenceImage(
  name: string, src: string, aspect: number,
  view: { from: THREE.Vector3; target: THREE.Vector3; fov: number; viewAspect: number },
): ReferenceImage {
  const distance = Math.max(4, view.from.distanceTo(view.target));
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2) * distance;
  const visibleWidth = visibleHeight * view.viewAspect;
  // fill about half the view without ever overflowing its shorter side
  const width = round(Math.max(1, Math.min(visibleWidth * 0.5, visibleHeight * 0.5 * aspect)));
  return {
    id: freshSceneId(), name: name.slice(0, 100) || 'Reference', src, aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 1,
    position: view.target.toArray().map(round) as XYZ, rotation: facing(view.from, view.target),
    width, opacity: 0.6, visible: true, locked: false,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000 + 0;

/** The XYZ Euler degrees that turn a panel (its front along +Z) to face a camera at `from` looking at `target`. */
export function facing(from: THREE.Vector3, target: THREE.Vector3): XYZ {
  const m = new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0));
  // lookAt aims -Z at the target; the panel's front is +Z, so it must point back at the camera
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z].map((r) => round(THREE.MathUtils.radToDeg(r))) as XYZ;
}

export const quaternionOf = (rotation: XYZ): THREE.Quaternion =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation.map((d) => THREE.MathUtils.degToRad(d)) as [number, number, number], 'XYZ'));

export const rotationOf = (q: THREE.Quaternion): XYZ => {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z].map((r) => round(THREE.MathUtils.radToDeg(r))) as XYZ;
};

/** Turns an image a quarter turn (or any angle) about the world axis `axis` (0 X, 1 Y, 2 Z). */
export function turnImage(image: ReferenceImage, axis: 0 | 1 | 2, degrees: number): XYZ {
  const about = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  const q = new THREE.Quaternion().setFromAxisAngle(about, THREE.MathUtils.degToRad(degrees)).multiply(quaternionOf(image.rotation));
  return rotationOf(q);
}

export function updateImage(setup: SceneSetup, id: string, patch: Partial<ReferenceImage>): SceneSetup {
  return { ...setup, images: imagesOf(setup).map((i) => (i.id === id ? { ...i, ...patch, id: i.id } : i)) };
}
export function addImage(setup: SceneSetup, image: ReferenceImage): SceneSetup {
  return { ...setup, images: [...imagesOf(setup), image].slice(-MAX_REFERENCE_IMAGES) };
}
export function removeImage(setup: SceneSetup, id: string): SceneSetup {
  const images = imagesOf(setup).filter((i) => i.id !== id);
  const { images: _gone, ...rest } = setup;
  return images.length ? { ...rest, images } : rest;
}

/**
 * Reads a picture file into a data URL no bigger than REFERENCE_MAX_PIXELS on its long
 * side (WebP, so transparency survives; PNG where the browser cannot write WebP).
 */
export async function readReferenceFile(file: File): Promise<{ name: string; src: string; aspect: number }> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not a picture.`);
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name} could not be read as a picture.`); });
  try {
    const scale = Math.min(1, REFERENCE_MAX_PIXELS / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw pictures.');
    ctx.drawImage(bitmap, 0, 0, w, h);
    let src = canvas.toDataURL('image/webp', 0.92);
    if (!src.startsWith('data:image/webp')) src = canvas.toDataURL('image/png');
    if (src.length > MAX_REFERENCE_SRC) src = canvas.toDataURL('image/jpeg', 0.8);
    if (src.length > MAX_REFERENCE_SRC) throw new Error(`${file.name} is too large to keep with the project.`);
    return { name: file.name.replace(/\.[^.]+$/, ''), src, aspect: w / h };
  } finally { bitmap.close(); }
}
