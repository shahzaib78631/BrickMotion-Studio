import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

/** Decoded BUILD_FL Z columns, expressed in camera heading coordinates (right, ahead, up). */
export const BUILD_FL_DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [-0.0243062023, -0.0180818997, 0.0261200145],
  [-0.0227769706, 0.0261386409, 0.0199495032],
  [0.0243750289, -0.0061585465, 0.0311116036],
  [0.0263558552, 0.0225252733, 0.0199495032],
];
export type ReferenceLightingOptions = {
  /** Area-light radiance, fitted jointly in linear light. */
  strengths: [number, number, number, number];
  environment: number;
  roughness: number;
  clearcoat: number;
  coatRoughness: number;
  /** Full angular diameter in radians. EyeSight's BUILD suns have size 1. */
  diameter: number;
  shadowRadius: number;
  /** Low-frequency mould surface bump height in world studs; 0 disables it. */
  mold: number;
  cameraRelative: boolean;
  /** Experimental single-layer glossy visibility; keep off unless fitting improves. */
  specularVisibility: boolean;
  burleyDiffuse: boolean;
  darkRoughness: number;
  cameraTilt: boolean;
  toneCurve?: number[];
};
export const DEFAULT_REFERENCE_LIGHTING: ReferenceLightingOptions = {
  strengths: [1.0495340366, 0.2962676139, 0.6450819005, 0.5766005847], environment: 0.1685396696, roughness: 0.35,
  clearcoat: 0.25, coatRoughness: 0.08, diameter: 1.35, shadowRadius: 6, mold: 0.025, cameraRelative: true, specularVisibility: false, burleyDiffuse: false, darkRoughness: 0.45, cameraTilt: false,
};

// Shared brick materials are drawn sequentially by studios. Bind this studio's
// values immediately before rendering, just like the existing shared finish state.
const enabled = { value: 0 };
const finish = { value: new THREE.Vector3() };
const mold = { value: 0 };
const matrices = { value: Array.from({ length: 4 }, () => new THREE.Matrix4()) };
const burley = { value: 0 };
const darkRoughness = { value: 0.54 };
const toneLow = { value: new THREE.Vector4(0, 0.004, 0.012, 0.03) };
const toneHigh = { value: new THREE.Vector4(0.07, 0.15, 0.35, 1) };
export function bindReferenceLighting(options: ReferenceLightingOptions | null, shadowMatrices?: THREE.Matrix4[]): void {
  enabled.value = options ? 1 : 0;
  if (options) finish.value.set(options.roughness, options.clearcoat, options.coatRoughness);
  mold.value = options?.mold ?? 0;
  if (shadowMatrices) matrices.value = shadowMatrices;
  burley.value = options?.burleyDiffuse ? 1 : 0;
  darkRoughness.value = options?.darkRoughness ?? 0.54;
  const curve = options?.toneCurve ?? [0, 0.004, 0.012, 0.03, 0.07, 0.15, 0.35, 1];
  toneLow.value.set(curve[0], curve[1], curve[2], curve[3]);
  toneHigh.value.set(curve[4], curve[5], curve[6], curve[7]);
}

/** Pair each analytic area light with a zero-energy directional shadow caster.
 * Reuse its visibility from the existing directional loop: no second shadow lookup.
 * This is a finite-area approximation to the reference's finite-angular sun, not
 * an exact spherical light integral. It keeps the model and all its real blockers.
 */
export function referenceMaterialShader(shader: Parameters<THREE.Material['onBeforeCompile']>[0], eligible: boolean, dark = false): void {
  shader.uniforms.bmReferenceRig = enabled;
  shader.uniforms.bmReferenceFinish = finish;
  shader.uniforms.bmReferenceMold = mold;
  shader.uniforms.bmReferenceMatrices = matrices;
  shader.uniforms.bmReferenceBurley = burley;
  shader.uniforms.bmReferenceDarkRoughness = darkRoughness;
  shader.uniforms.bmToneLow = toneLow; shader.uniforms.bmToneHigh = toneHigh;
  const shadowLine = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
  let begin = THREE.ShaderChunk.lights_fragment_begin;
  if (!begin.includes(shadowLine)) throw new Error('Reference lighting: Three.js shadow shader changed');
  begin = `
#if NUM_DIR_LIGHT_SHADOWS > 0
float bmReferenceVisibility[NUM_DIR_LIGHT_SHADOWS];
float bmReferenceSpecVisibility[NUM_DIR_LIGHT_SHADOWS];
float bmShadow;
vec3 bmBeforeDiffuse, bmBeforeSpecular;
#ifdef USE_CLEARCOAT
vec3 bmBeforeCoat;
#endif
#endif
${begin}`.replace(shadowLine, `
bmShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
bmReferenceVisibility[i] = bmShadow;
bmReferenceSpecVisibility[i] = bmShadow;
#if defined(SHADOWMAP_TYPE_BASIC)
if (bmReferenceRig > 0.5) {
  bmReferenceVisibility[i] = bmSoftVisibility(directionalShadowMap[i], vDirectionalShadowCoord[i], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowRadius);
  bmReferenceSpecVisibility[i] = bmSpecVisibility(directionalShadowMap[i], vDirectionalShadowCoord[i], bmReferenceMatrices[i], geometryNormal, geometryViewDir);
}
#endif
directLight.color *= bmShadow;`).replace('rectAreaLight = rectAreaLights[ i ];', `rectAreaLight = rectAreaLights[ i ];
#if defined(USE_SHADOWMAP) && (UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS)
bmBeforeDiffuse = reflectedLight.directDiffuse; bmBeforeSpecular = reflectedLight.directSpecular;
#ifdef USE_CLEARCOAT
bmBeforeCoat = clearcoatSpecularDirect;
#endif
#endif`).replace('RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );', `RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#if defined(USE_SHADOWMAP) && (UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS)
if (bmReferenceRig > 0.5) {
  reflectedLight.directDiffuse = bmBeforeDiffuse + (reflectedLight.directDiffuse - bmBeforeDiffuse) * bmReferenceVisibility[i] *
    mix(1.0, bmBurleyFactor(geometryNormal, geometryViewDir, normalize(rectAreaLight.position - geometryPosition), material.roughness), bmReferenceBurley * ${eligible ? '1.0' : '0.0'});
  reflectedLight.directSpecular = bmBeforeSpecular + (reflectedLight.directSpecular - bmBeforeSpecular) * mix(bmReferenceSpecVisibility[i], bmReferenceVisibility[i], material.roughness);
  #ifdef USE_CLEARCOAT
  clearcoatSpecularDirect = bmBeforeCoat + (clearcoatSpecularDirect - bmBeforeCoat) * bmReferenceSpecVisibility[i];
  #endif
}
#endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float bmReferenceRig; uniform vec3 bmReferenceFinish;
uniform mat4 bmReferenceMatrices[4];
uniform float bmReferenceBurley;
uniform float bmReferenceDarkRoughness;
uniform vec4 bmToneLow, bmToneHigh;
float bmTone(float x) {
  if (x <= 0.004) return mix(bmToneLow.x, bmToneLow.y, clamp(x / 0.004, 0.0, 1.0));
  if (x <= 0.012) return mix(bmToneLow.y, bmToneLow.z, (x - 0.004) / 0.008);
  if (x <= 0.03) return mix(bmToneLow.z, bmToneLow.w, (x - 0.012) / 0.018);
  if (x <= 0.07) return mix(bmToneLow.w, bmToneHigh.x, (x - 0.03) / 0.04);
  if (x <= 0.15) return mix(bmToneHigh.x, bmToneHigh.y, (x - 0.07) / 0.08);
  if (x <= 0.35) return mix(bmToneHigh.y, bmToneHigh.z, (x - 0.15) / 0.2);
  return mix(bmToneHigh.z, bmToneHigh.w, clamp((x - 0.35) / 0.65, 0.0, 1.0));
}
// Disney diffuse: FD90 = 0.5 + 2 roughness (L.H)^2. This changes grazing
// diffuse response without adding a fabric sheen or a white specular overlay.
// LTC integrates the Lambert base; its Burley ratio is evaluated at the area centre.
float bmBurleyFactor(vec3 n, vec3 v, vec3 l, float roughness) {
  vec3 h = normalize(l + v);
  float lh = max(dot(l, h), 0.0);
  float fd90 = 0.5 + 2.0 * roughness * lh * lh;
  float nl = 1.0 - clamp(dot(n, l), 0.0, 1.0), nv = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  float nl2 = nl * nl, nv2 = nv * nv;
  return (1.0 + (fd90 - 1.0) * nl2 * nl2 * nl) * (1.0 + (fd90 - 1.0) * nv2 * nv2 * nv);
}
#if defined(SHADOWMAP_TYPE_BASIC)
float bmSoftVisibility(sampler2D depthMap, vec4 coordinate, vec2 size, float radius) {
  vec3 q = coordinate.xyz / coordinate.w;
  if (q.z > 1.0 || q.z < 0.0 || any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
  vec2 d = vec2(radius * 0.5) / size;
  float z = q.z - 0.00015;
  return 0.25 * (step(z, texture2D(depthMap, q.xy + d).r) + step(z, texture2D(depthMap, q.xy - d).r)
    + step(z, texture2D(depthMap, q.xy + d * vec2(1,-1)).r) + step(z, texture2D(depthMap, q.xy + d * vec2(-1,1)).r));
}
// A bounded reflection ray through the light-space depth heightfield. This sees
// shadow-casting geometry outside the camera image, unlike screen-space reflections.
// It is a single-layer approximation, not full glossy path tracing.
float bmSpecVisibility(sampler2D depthMap, vec4 coordinate, mat4 lightMatrix, vec3 n, vec3 v) {
  vec3 p = coordinate.xyz / coordinate.w;
  vec3 ray = transformDirectionByInverseViewMatrix(reflect(-v, n), viewMatrix);
  vec3 direction = (lightMatrix * vec4(ray, 0.0)).xyz;
  if (direction.z >= -1e-5) return 1.0;
  float previous = 0.0, occluded = 0.0;
  for (int stepIndex = 0; stepIndex < 8; stepIndex++) {
    float t = (float(stepIndex) + 1.0) / 8.0;
    vec3 q = p + direction * (t * t * 3.0);
    if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) break;
    float depth = texture2D(depthMap, q.xy).r;
    float gap = (q.z - depth) / max(abs(direction.z), 1e-5);
    if (previous > 0.04 && gap <= 0.02) occluded = 1.0;
    previous = gap;
  }
  return 1.0 - occluded;
}
#endif`)
    .replace('#include <lights_fragment_begin>', begin)
    .replace('#include <tonemapping_fragment>', `
#ifdef TONE_MAPPING
if (bmReferenceRig > 0.5) gl_FragColor.rgb = vec3(bmTone(gl_FragColor.r), bmTone(gl_FragColor.g), bmTone(gl_FragColor.b));
#endif
#include <tonemapping_fragment>`);
  if (eligible) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 bmGenerated; varying vec3 vBmGenerated;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBmGenerated = bmGenerated;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vBmGenerated; uniform float bmReferenceMold;
float bmMoldHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float bmMoldNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bmMoldHash(i), bmMoldHash(i + vec3(1,0,0)), f.x), mix(bmMoldHash(i + vec3(0,1,0)), bmMoldHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(bmMoldHash(i + vec3(0,0,1)), bmMoldHash(i + vec3(1,0,1)), f.x), mix(bmMoldHash(i + vec3(0,1,1)), bmMoldHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (bmReferenceRig > 0.5 && bmReferenceMold > 0.0) {
  float h = bmMoldNoise(vBmGenerated * 2.0);
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1) * faceDirection;
  vec3 gradient = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2) * bmReferenceMold;
  normal = normalize(max(abs(det), 1e-10) * normal - gradient);
}`)
      .replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
if (bmReferenceRig > 0.5 && bmReferenceMold > 0.0) clearcoatNormal = normal;
#endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
if (bmReferenceRig > 0.5) {
  material.roughness = min(1.0, max(0.0525, ${dark ? 'bmReferenceDarkRoughness' : 'bmReferenceFinish.x'}) + geometryRoughness);
  #ifdef USE_CLEARCOAT
  material.clearcoat = bmReferenceFinish.y;
  material.clearcoatRoughness = min(1.0, max(0.0525, bmReferenceFinish.z) + geometryRoughness);
  #endif
}`);
  }
}

let initialized = false;
export class ReferenceLighting {
  readonly group = new THREE.Group();
  readonly panels: THREE.RectAreaLight[] = [];
  readonly casters: THREE.DirectionalLight[] = [];
  readonly shadowMatrices: THREE.Matrix4[] = [];
  options: ReferenceLightingOptions = { ...DEFAULT_REFERENCE_LIGHTING, strengths: [...DEFAULT_REFERENCE_LIGHTING.strengths] };
  private previous = '';
  private position = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    if (!initialized) { RectAreaLightUniformsLib.init(); initialized = true; }
    this.group.name = 'EyeSight reference lighting'; this.group.visible = false;
    for (let i = 0; i < 4; i++) {
      const area = new THREE.RectAreaLight(0xffffff, 1, 1, 1);
      const shadow = new THREE.DirectionalLight(0xffffff, 0);
      shadow.castShadow = true;
      shadow.shadow.mapSize.set(768, 768);
      shadow.shadow.bias = -0.00008;
      shadow.shadow.normalBias = 0.008;
      shadow.shadow.autoUpdate = false;
      this.panels.push(area); this.casters.push(shadow);
      this.shadowMatrices.push(shadow.shadow.matrix);
      this.group.add(area, shadow, shadow.target);
    }
  }

  configure(options: ReferenceLightingOptions): void {
    if (options.specularVisibility !== this.options.specularVisibility) this.invalidate();
    this.options = { ...options, strengths: [...options.strengths] };
  }

  update(camera: THREE.Camera, center: THREE.Vector3, radius: number, structure: number, pose: number): void {
    camera.updateWorldMatrix(true, false);
    camera.getWorldDirection(this.forward);
    this.up.set(0, 1, 0);
    if (!this.options.cameraTilt) this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, -1);
    this.forward.normalize(); this.right.crossVectors(this.forward, this.up).normalize();
    if (this.options.cameraTilt) this.up.crossVectors(this.right, this.forward).normalize();
    if (!this.options.cameraRelative) { this.forward.set(0, 0, -1); this.right.set(1, 0, 0); this.up.set(0, 1, 0); }
    const signature = `${structure}|${pose}|${center.toArray()}|${radius}|${this.forward.toArray()}|${this.options.shadowRadius}|${this.options.diameter}`;
    const dirty = signature !== this.previous; this.previous = signature;
    const distance = Math.max(100, radius * 20); // angular extent is scale invariant
    const width = 2 * distance * Math.tan(this.options.diameter / 2);
    BUILD_FL_DIRECTIONS.forEach(([x, y, z], i) => {
      this.direction.copy(this.right).multiplyScalar(x).addScaledVector(this.forward, y).addScaledVector(this.up, z).normalize();
      this.position.copy(center).addScaledVector(this.direction, distance);
      const panel = this.panels[i];
      panel.position.copy(this.position); panel.lookAt(center); panel.width = panel.height = width;
      panel.intensity = this.options.strengths[i];
      const caster = this.casters[i];
      // Shadow map needs a compact near/far range, independent of panel distance.
      caster.position.copy(center).addScaledVector(this.direction, radius * 3);
      caster.target.position.copy(center); caster.target.updateMatrixWorld();
      const frustum = caster.shadow.camera;
      frustum.left = frustum.bottom = -radius * 1.15; frustum.right = frustum.top = radius * 1.15;
      frustum.near = radius; frustum.far = radius * 5;
      frustum.updateProjectionMatrix();
      caster.shadow.radius = this.options.shadowRadius;
      caster.updateWorldMatrix(true, false); caster.shadow.updateMatrices(caster);
      if (dirty) caster.shadow.needsUpdate = true;
    });
  }

  invalidate(): void { this.previous = ''; }
  dispose(): void { for (const light of this.casters) light.shadow.dispose(); this.group.clear(); }
}
