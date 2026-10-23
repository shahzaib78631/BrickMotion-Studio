import * as THREE from 'three';
import type { ColorDef } from '../ldraw/colors';

const cache = new Map<string, THREE.Material>();

const FALLBACK: ColorDef = { code: 71, name: 'Light_Bluish_Gray', hex: '#A0A5A9', edge: '#333333', alpha: 255, finish: 'solid' };

/** Plastic brick material for an LDraw color. Cached per (code, sidedness). */
export function materialFor(color: ColorDef | undefined, doubleSided: boolean): THREE.Material {
  const c = color ?? FALLBACK;
  const key = `${c.code}|${doubleSided ? 2 : 1}`;
  let m = cache.get(key);
  if (m) return m;
  const params: THREE.MeshPhysicalMaterialParameters = {
    color: new THREE.Color(c.hex),
    // Broad softbox highlights instead of the hard plastic glare in the
    // original near-white studio. Color codes themselves are unchanged.
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.16,
    clearcoatRoughness: 0.36,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    // pushes faces slightly back so the outline edges draw on top of them
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };
  if (c.finish === 'trans') Object.assign(params, { transparent: true, opacity: c.alpha / 255, depthWrite: false, transmission: 0.6, roughness: 0.1, thickness: 0.5 });
  else if (c.finish === 'chrome') Object.assign(params, { metalness: 1, roughness: 0.15 });
  else if (c.finish === 'metal') Object.assign(params, { metalness: 0.8, roughness: 0.3 });
  else if (c.finish === 'pearl') Object.assign(params, { metalness: 0.5, roughness: 0.3 });
  else if (c.finish === 'rubber') Object.assign(params, { roughness: 0.86, clearcoat: 0 });
  m = new THREE.MeshPhysicalMaterial(params);
  cache.set(key, m);
  return m;
}

let placeholder: THREE.Material | null = null;
export function placeholderMaterial(): THREE.Material {
  return (placeholder ??= new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.6, transparent: true, opacity: 0.6 }));
}

/** How strong the faint outline edges are (LDraw edge colour at this opacity). */
export const EDGE_OPACITY = 0.3;
const edgeCache = new Map<number, THREE.LineBasicMaterial>();

/**
 * Faint LDraw outline edges for instanced bricks. The lines reuse the bricks'
 * own per-instance matrices (USE_INSTANCING), so they move with them for free.
 */
export function edgeMaterialFor(color: ColorDef | undefined): THREE.LineBasicMaterial {
  const c = color ?? FALLBACK;
  let m = edgeCache.get(c.code);
  if (m) return m;
  m = new THREE.LineBasicMaterial({ color: new THREE.Color(c.edge), transparent: true, opacity: c.finish === 'trans' ? EDGE_OPACITY * 0.6 : EDGE_OPACITY, depthWrite: false });
  m.defines = { USE_INSTANCING: '' };
  edgeCache.set(c.code, m);
  return m;
}
