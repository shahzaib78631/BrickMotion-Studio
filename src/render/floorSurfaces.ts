import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/** Where the floor fades into the backdrop: around the model, in world units. */
export type FloorFade = { center: { value: THREE.Vector3 }; radius: { value: number } };
export const createFade = (): FloorFade => ({ center: { value: new THREE.Vector3() }, radius: { value: 40 } });

/** A lit floor whose edge melts into the screen-space backdrop instead of drawing a horizon line. */
export function fadingFloorMaterial(fade: FloorFade, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, ...params });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.bmFadeCenter = fade.center;
    shader.uniforms.bmFadeRadius = fade.radius;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBmWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvBmWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBmWorld;\nuniform vec3 bmFadeCenter;\nuniform float bmFadeRadius;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= 1.0 - smoothstep(0.45, 1.0, length(vBmWorld.xz - bmFadeCenter.xz) / bmFadeRadius);');
  };
  m.customProgramCacheKey = () => 'bm-fading-floor';
  return m;
}

/** A blurred, faded mirror: the glossy table of product shots. */
const ReflectionShader = {
  name: 'BrickMotionReflection',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    strength: { value: 0.3 },
    bmFadeCenter: { value: new THREE.Vector3() },
    bmFadeRadius: { value: 40 },
    texel: { value: 1 / 1024 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform vec3 bmFadeCenter;
    uniform float bmFadeRadius;
    uniform float texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vUv.xy / vUv.w;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.36;
      c += texture2D(tDiffuse, uv + vec2(2.5 * texel, 0.0)).rgb * 0.16;
      c += texture2D(tDiffuse, uv - vec2(2.5 * texel, 0.0)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(0.0, 2.5 * texel)).rgb * 0.16;
      c += texture2D(tDiffuse, uv - vec2(0.0, 2.5 * texel)).rgb * 0.16;
      float d = length(vWorld.xz - bmFadeCenter.xz) / bmFadeRadius;
      float fade = 1.0 - smoothstep(0.2, 0.85, d);
      gl_FragColor = vec4(c * color, strength * fade);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export function createReflection(fade: FloorFade, size = 1024): Reflector {
  const r = new Reflector(new THREE.PlaneGeometry(1000, 1000), {
    textureWidth: size, textureHeight: size, clipBias: 0.003, color: 0xffffff, shader: ReflectionShader,
  });
  const mat = r.material as THREE.ShaderMaterial;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.uniforms.bmFadeCenter = fade.center;
  mat.uniforms.bmFadeRadius = fade.radius;
  mat.uniforms.texel.value = 1 / size;
  r.rotation.x = -Math.PI / 2;
  r.renderOrder = -2;
  return r;
}

/** Deterministic pseudo-random numbers, so preview and export draw the same grain. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const tile = (pixels: Uint8Array, size: number, studs: number) => {
  const t = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // the floor plane is 1000 units wide: one tile covers `studs` studs
  t.repeat.set(1000 / studs, 1000 / studs);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
};

/** Light oak planks, 6 planks per tile. DataTexture works on OffscreenCanvas too. */
export function woodTexture(size = 256): THREE.DataTexture {
  const px = new Uint8Array(size * size * 4);
  const rand = rng(7);
  const planks = 6;
  const tones = Array.from({ length: planks }, () => 0.86 + rand() * 0.18);
  const phase = Array.from({ length: planks }, () => rand() * 40);
  for (let y = 0; y < size; y++) {
    const plank = Math.floor((y / size) * planks);
    const inPlank = ((y / size) * planks) % 1;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const grain = 0.5 + 0.5 * Math.sin((u * 26 + Math.sin(u * 9 + phase[plank]) * 0.9 + inPlank * 3) * Math.PI);
      const fine = 0.5 + 0.5 * Math.sin((u * 140 + phase[plank] * 3) * Math.PI);
      let k = tones[plank] * (0.9 + grain * 0.08 + fine * 0.03);
      if (inPlank < 0.025 || inPlank > 0.975) k *= 0.72; // seams
      const o = (y * size + x) * 4;
      px[o] = Math.min(255, 214 * k); px[o + 1] = Math.min(255, 176 * k); px[o + 2] = Math.min(255, 128 * k); px[o + 3] = 255;
    }
  }
  return tile(px, size, 18);
}

/** Smooth grey concrete with soft mottling and pores. */
export function concreteTexture(size = 256): THREE.DataTexture {
  const px = new Uint8Array(size * size * 4);
  const rand = rng(11);
  // a small periodic value-noise grid keeps the tile seamless
  const g = 16;
  const grid = Array.from({ length: g * g }, () => rand());
  const at = (i: number, j: number) => grid[((j % g) + g) % g * g + ((i % g) + g) % g];
  const noise = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x / size) * g, v = (y / size) * g;
    const mottle = noise(u / 4, v / 4) * 0.6 + noise(u, v) * 0.4;
    const pore = rand() > 0.995 ? 0.8 : 1;
    const k = (0.82 + mottle * 0.16 + (rand() - 0.5) * 0.04) * pore;
    const o = (y * size + x) * 4;
    px[o] = 176 * k; px[o + 1] = 176 * k; px[o + 2] = 172 * k; px[o + 3] = 255;
  }
  return tile(px, size, 30);
}
