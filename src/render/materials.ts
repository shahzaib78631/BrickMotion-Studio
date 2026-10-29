import * as THREE from 'three';
import type { ColorDef } from '../ldraw/colors';
import { finishOf, type BrickFinish, type BrickTexture } from './looks';

const cache = new Map<string, THREE.MeshPhysicalMaterial>();

const FALLBACK: ColorDef = { code: 71, name: 'Light_Bluish_Gray', hex: '#A0A5A9', edge: '#333333', alpha: 255, finish: 'solid' };

/** The finish and texture every brick uses. Materials are cached and shared by every
 * studio on the page (viewport, export), so a change re-styles them in place. */
let profile: { finish: BrickFinish; texture: BrickTexture } = { finish: 'studio', texture: 'none' };
const TEXTURE_ID: Record<BrickTexture, number> = { none: 0, grain: 1, worn: 2, speckle: 3, glitter: 4 };

/** Value noise and a derivative bump, in the part's own coordinates (LDU), so the
 * texture sticks to each part as it flies. LDraw geometry has no UVs. */
const TEXTURE_PARS = /* glsl */ `
varying vec3 vBmPos;
float bmHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float bmNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bmHash(i), bmHash(i + vec3(1, 0, 0)), f.x), mix(bmHash(i + vec3(0, 1, 0)), bmHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(bmHash(i + vec3(0, 0, 1)), bmHash(i + vec3(1, 0, 1)), f.x), mix(bmHash(i + vec3(0, 1, 1)), bmHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 bmPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos); vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm); vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;
/** Per texture: a height (for the bump), a roughness change, a colour change and a sparkle mask. */
const TEXTURE_BODY = /* glsl */ `
  float bmH = 0.0; float bmRough = 0.0; float bmSpark = 0.0; float bmBump = 0.0;
#if BM_TEXTURE == 1
  bmH = bmNoise(vBmPos * 0.55) * 0.55 + bmNoise(vBmPos * 1.7) * 0.45;
  bmRough = 0.06 + (bmH - 0.5) * 0.16; bmBump = 0.35;
#elif BM_TEXTURE == 2
  float bmBlotch = smoothstep(0.5, 0.82, bmNoise(vBmPos * 0.07 + 3.1));
  float bmScratch = smoothstep(0.9, 0.985, bmNoise(vBmPos * vec3(0.9, 0.06, 0.9))) + smoothstep(0.9, 0.985, bmNoise(vBmPos.zyx * vec3(0.9, 0.06, 0.9) + 7.0));
  bmH = bmScratch * 0.6 + bmNoise(vBmPos * 1.2) * 0.15;
  bmRough = bmBlotch * 0.28 + bmScratch * 0.2; bmBump = 0.5;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.9 + 0.08, clamp(bmScratch, 0.0, 1.0) * 0.6);
  diffuseColor.rgb *= 1.0 - bmBlotch * 0.06;
#elif BM_TEXTURE == 3
  float bmDots = smoothstep(0.86, 0.9, bmNoise(vBmPos * 0.6)) * 0.7 + smoothstep(0.88, 0.92, bmNoise(vBmPos * 1.4 + 11.0)) * 0.45;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, clamp(bmDots, 0.0, 1.0));
#elif BM_TEXTURE == 4
  vec3 bmCell = floor(vBmPos * 1.5);
  bmSpark = step(0.968, bmHash(bmCell)) * (0.6 + 0.4 * bmHash(bmCell + 5.0));
  // flakes catch the light at their own angle: a tilted normal, mirror-like
  bmH = bmSpark * bmHash(bmCell + 9.0); bmBump = 0.6;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.15, bmSpark * 0.4);
#endif
`;

function installTexture(m: THREE.MeshPhysicalMaterial) {
  m.onBeforeCompile = (shader) => {
    const id = (m.userData.bmTexture as number) ?? 0;
    shader.defines = { ...(shader.defines ?? {}), BM_TEXTURE: id };
    if (!id) return;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBmPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBmPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TEXTURE_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${TEXTURE_BODY}`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = clamp(mix(roughnessFactor + bmRough, 0.06, bmSpark), 0.04, 1.0);\nmetalnessFactor = mix(metalnessFactor, 1.0, bmSpark);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (bmBump > 0.0) normal = bmPerturb(-vViewPosition, normal, vec2(dFdx(bmH), dFdy(bmH)) * bmBump, faceDirection);');
  };
  m.customProgramCacheKey = () => `bm-texture-${(m.userData.bmTexture as number) ?? 0}`;
}

/** Applies the LDraw colour, then the current finish and texture, to a material. */
function style(m: THREE.MeshPhysicalMaterial, c: ColorDef) {
  const f = finishOf(profile.finish);
  const special = c.finish === 'trans' || c.finish === 'chrome' || c.finish === 'metal' || c.finish === 'pearl' || c.finish === 'rubber';
  m.color.set(f.tint && c.finish !== 'trans' ? f.tint : c.hex);
  m.roughness = f.roughness;
  m.metalness = f.metalness;
  m.clearcoat = f.clearcoat;
  m.clearcoatRoughness = f.clearcoatRoughness;
  m.iridescence = special ? 0 : f.iridescence ?? 0;
  m.sheen = special ? 0 : f.sheen ?? 0;
  m.sheenRoughness = 0.6;
  m.sheenColor.set(f.tint && c.finish !== 'trans' ? f.tint : c.hex).lerp(new THREE.Color('#ffffff'), 0.5);
  if (!f.tint || c.finish === 'trans') {
    if (c.finish === 'trans') Object.assign(m, { transparent: true, opacity: c.alpha / 255, depthWrite: false, transmission: 0.6, roughness: 0.1, thickness: 0.5 });
    else if (c.finish === 'chrome') Object.assign(m, { metalness: 1, roughness: 0.15 });
    else if (c.finish === 'metal') Object.assign(m, { metalness: 0.8, roughness: 0.3 });
    else if (c.finish === 'pearl') Object.assign(m, { metalness: 0.5, roughness: 0.3 });
    else if (c.finish === 'rubber') Object.assign(m, { roughness: 0.86, clearcoat: 0 });
  }
  // rubber tyres and transparent parts keep their own surface
  const texture = c.finish === 'trans' || c.finish === 'rubber' ? 0 : TEXTURE_ID[profile.texture];
  if (m.userData.bmTexture !== texture) {
    m.userData.bmTexture = texture;
    m.needsUpdate = true;
  }
}

/** Plastic brick material for an LDraw color. Cached per (code, sidedness). */
export function materialFor(color: ColorDef | undefined, doubleSided: boolean): THREE.Material {
  const c = color ?? FALLBACK;
  const key = `${c.code}|${doubleSided ? 2 : 1}`;
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.MeshPhysicalMaterial({
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    // pushes faces slightly back so the outline edges draw on top of them
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  m.userData.bmColor = c;
  installTexture(m);
  style(m, c);
  cache.set(key, m);
  return m;
}

/** Re-styles every brick material: Materials → Brick finish and texture. */
export function setBrickMaterials(next: { finish: BrickFinish; texture: BrickTexture }): void {
  if (next.finish === profile.finish && next.texture === profile.texture) return;
  profile = { finish: next.finish, texture: next.texture };
  for (const m of cache.values()) style(m, m.userData.bmColor as ColorDef);
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
