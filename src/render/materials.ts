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
    roughness: 0.35,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.3,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  };
  if (c.finish === 'trans') Object.assign(params, { transparent: true, opacity: c.alpha / 255, depthWrite: false, transmission: 0.6, roughness: 0.1, thickness: 0.5 });
  else if (c.finish === 'chrome') Object.assign(params, { metalness: 1, roughness: 0.15 });
  else if (c.finish === 'metal') Object.assign(params, { metalness: 0.8, roughness: 0.3 });
  else if (c.finish === 'pearl') Object.assign(params, { metalness: 0.5, roughness: 0.3 });
  else if (c.finish === 'rubber') Object.assign(params, { roughness: 0.8, clearcoat: 0 });
  m = new THREE.MeshPhysicalMaterial(params);
  cache.set(key, m);
  return m;
}

let placeholder: THREE.Material | null = null;
export function placeholderMaterial(): THREE.Material {
  return (placeholder ??= new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.6, transparent: true, opacity: 0.6 }));
}
