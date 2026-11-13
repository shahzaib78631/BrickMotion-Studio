import * as THREE from 'three';
import { EYESIGHT_COLORS } from '../data/eyesightColors.generated';
import { EYESIGHT_PIPELINE } from '../data/eyesightPipeline.generated';
import { materialName, type ColorDef } from '../ldraw/colors';

/** Preserve Studio's linear RGB floats; hex round-tripping quantizes dark colours. */
export function pathTraceColor(def: ColorDef, palette: 'studio' | 'ldraw'): THREE.Color {
  const source = palette === 'studio' ? EYESIGHT_COLORS[materialName(def)] : undefined;
  return source ? new THREE.Color().setRGB(source[0], source[1], source[2], THREE.LinearSRGBColorSpace) : new THREE.Color(def.hex);
}

/** Installed BUILD_FL emission strengths, in XML order FL, RL, FR, RR. */
export const EYESIGHT_BUILD_STRENGTHS = [3, 1, 1, 1] as const;
/** EyeSight's background_shader is white (CLI `--param 0 1 1 1`) at the XML Strength 0.15 —
 * this is the world that lights the bricks. The visible backdrop is that same white world at
 * full brightness, set separately as `scene.background` (a texture: a THREE.Color renders
 * black in this tracer). Verified against the binary: a `--param 0 0 0` render gives a black
 * backdrop, and `--param 0 1 1 1` reproduces calib_az0.png to the pixel
 * (mean [236.5,233.8,233.1] vs the reference [236.4,233.6,232.9]). */
export const EYESIGHT_WORLD_STRENGTH = EYESIGHT_PIPELINE.worldStrength;
export const EYESIGHT_IOR = EYESIGHT_PIPELINE.solid.ior;
/** Uniform diffuse multiplier matching the model's overall level to calib_az0.png (~0.65x). Kept
 * as the source default because the DirtOnScratch mix below trades p95 down but lifts p5 (cavity
 * darkness) the wrong way — measured p5 0.247 vs the reference's 0.149, against 0.169 for this. */
export const EYESIGHT_SOLID_DIFFUSE_GAIN = 0.65;
/** EyeSight's SOLID-GROUP mixes its Principled BSDF with the DirtOnScratch layer: a diffuse of
 * EYESIGHT_SCRATCH_DIFFUSE at strength MinScratchStrength 0.15 .. MaxScratchStrength 0.5. That
 * darkens a brick's base colour toward grey, and unlike a uniform multiplier it compresses the
 * highlights (p95 0.984 -> 0.918) — but it lifts the cavities too (p5 0.173 -> 0.318). Available
 * as `?scratch=`; off by default (see EYESIGHT_SOLID_DIFFUSE_GAIN). base*(1-mix) + scratch*mix. */
export const EYESIGHT_SOLID_SCRATCH_MIX = 0.5;
export const EYESIGHT_SCRATCH_DIFFUSE = 0.12045222520828247;
/** Experimental image-space sky-visibility multiplier for the fitted profile.
 * The XML's denoising_ao_strength=0.5 is a denoiser parameter; it does NOT prove
 * that EyeSight multiplies this visibility over its final colour. Native mode
 * disables this heuristic rather than claiming it ports EyeSight's denoiser. */
export const EYESIGHT_AO_STRENGTH = 0.5;
/** EyeSight's film reconstructs with a Blackman-Harris filter, width 1.5px (`filter_type` /
 * `filter_width` in settings_v1.xml). This tracer has only a box filter, so its edges come out
 * sharper than EyeSight's (measured `grad` 0.056 vs 0.021 without it, and it does not fall with
 * more samples). A separable Gaussian of this sigma, applied in the composite, stands in for the
 * reconstruction filter. Calibrated on the geometry-mask `grad` (over the true silhouette), which
 * is the trustworthy measure — the reference-luminance heuristic over-weights the backdrop and
 * asks for a larger blur. */
export const EYESIGHT_BLUR = 0.6;
/** Installed SOLID-GROUP routes UVGroup directly into its BSDF. The disabled
 * UVDegradation node bypasses to MinRoughness (0.05), per native constant_fold
 * at 0x100da2f30. The Bright/Contrast node elsewhere in the XML belongs to
 * METAL-GROUP, not SOLID-GROUP, and must not be applied to ordinary ABS. */
export const EYESIGHT_NATIVE_SOLID_ROUGHNESS = EYESIGHT_PIPELINE.solid.roughness;
/** Empirically fitted source-inspired profile, retained for comparison. */
export const EYESIGHT_SOLID_ROUGHNESS = 0.35;

/** EyeSight's BUILD_FL suns are `distant` with `size="1.0"`, whose unit (radians vs
 * degrees) is not confirmed by the file. The angular size affects only the softbox
 * softness — `diskRadiance` conserves normal-incidence irradiance — so this value is
 * chosen for a softbox-like falloff, not read from the file. It must stay small
 * enough that the four panels do not fill the camera frame and hide the world
 * backdrop (a 90 deg panel does exactly that). */
export const EYESIGHT_SUN_DIAMETER = 0.3;

/** A distant circular emitter approximation. Preserve normal-incidence irradiance
 * when changing angular size: E = L π sin²(theta). The XML's size-to-angle
 * interpretation remains explicit rather than being folded into an arbitrary gain.
 */
export function diskRadiance(irradiance: number, diameter: number): number {
  const sine = Math.sin(THREE.MathUtils.clamp(diameter, 0.001, Math.PI - 0.001) / 2);
  return irradiance / (Math.PI * sine * sine);
}

/** Deterministic, low-frequency mould variation baked once into the part's shading
 * normals. Positions and silhouette stay untouched. This approximates NormalGroup,
 * not Cycles' scratch textures or ray-query rounding_edge_normal node.
 */
export function bakeMouldNormals(geometry: THREE.BufferGeometry, strength = 0.01): void {
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
  if (!p || !n || !strength) return;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
  const normal = new THREE.Vector3(), gradient = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const x = (p.getX(i) - center.x) / Math.max(size.x, 1e-6) * 2;
    const y = (p.getY(i) - center.y) / Math.max(size.y, 1e-6) * 2;
    const z = (p.getZ(i) - center.z) / Math.max(size.z, 1e-6) * 2;
    normal.fromBufferAttribute(n, i);
    gradient.set(Math.cos(x * 2.3 + z) * Math.sin(y + 0.7), Math.sin(x * 2.3 + z) * Math.cos(y + 0.7), Math.cos(x * 2.3 + z) * Math.sin(y + 0.7) / 2.3);
    gradient.addScaledVector(normal, -gradient.dot(normal));
    normal.addScaledVector(gradient, -strength).normalize();
    n.setXYZ(i, normal.x, normal.y, normal.z);
  }
  n.needsUpdate = true;
}
