import * as THREE from 'three';
import { materialName, type ColorDef } from '../ldraw/colors';
import { EYESIGHT_COLORS } from '../data/eyesightColors.generated';
import type { GlassLook, Palette } from './looks';

/** World distance is in studs in all three renderers. These are provisional
 * optical settings, not measurements of the user's photographed plastic. */
export const GLASS_REFERENCE_DISTANCE_STUDS = 0.3;
export const GLASS_FALLBACK_WALL_LDU = 1.2;
export const GLASS_IOR = 1.52;

export function glassTint(color: ColorDef, palette: Palette): THREE.Color {
  const rgb = palette === 'studio' ? EYESIGHT_COLORS[materialName(color)] : undefined;
  const tint = rgb ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace) : new THREE.Color(color.hex);
  // Zero spectral channels would imply infinite absorption. This finite floor
  // is retained from the existing palette proxy until measured data is available.
  return tint.setRGB(Math.max(.02, tint.r), Math.max(.02, tint.g), Math.max(.02, tint.b));
}

/** One optical definition shared by raster, interactive transport and export.
 * Surface reflectance stays neutral; dye colour belongs to volume absorption. */
export function applyGlassOptics(material: THREE.MeshPhysicalMaterial, color: ColorDef, look: GlassLook, palette: Palette): void {
  Object.assign(material, {
    transparent: false, opacity: 1, depthWrite: true,
    transmission: look === 'milky' ? .3 : 1,
    roughness: look === 'milky' ? .55 : look === 'clear' ? .02 : .1,
    metalness: 0, clearcoat: 0, sheen: 0, iridescence: 0, ior: GLASS_IOR,
    thickness: GLASS_FALLBACK_WALL_LDU,
    attenuationDistance: GLASS_REFERENCE_DISTANCE_STUDS,
  });
  material.color.setRGB(1, 1, 1);
  material.attenuationColor.copy(glassTint(color, palette));
  material.userData.bmGlass = { look, palette, units: 'studs', calibration: 'palette-proxy', referenceDistance: GLASS_REFERENCE_DISTANCE_STUDS };
  material.needsUpdate = true;
}

/** Strip viewport shader hooks while preserving the same optical medium.
 * Transport measures actual ray distances through the transformed mesh. */
export function transportGlass(source: THREE.MeshPhysicalMaterial, look?: GlassLook, palette?: Palette): THREE.MeshPhysicalMaterial {
  const material = source.clone();
  const def = source.userData.bmColor as ColorDef | undefined;
  if (def?.finish === 'trans') {
    applyGlassOptics(material, def, look ?? source.userData.bmGlass?.look ?? 'soft', palette ?? source.userData.bmGlass?.palette ?? 'studio');
  }
  return material;
}

export function transmittedFraction(tint: THREE.Color, distanceStuds: number, referenceDistance = GLASS_REFERENCE_DISTANCE_STUDS): THREE.Color {
  return new THREE.Color().setRGB(...tint.toArray().map(channel => Math.pow(channel, distanceStuds / referenceDistance)) as [number, number, number]);
}
