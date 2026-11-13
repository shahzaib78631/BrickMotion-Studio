import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
// @ts-expect-error Upstream WGSL helper has no ambient declaration.
import { wgslTagFn, rayStruct } from 'three-mesh-bvh/webgpu';
import { WebGPUPathTracer, RANDOM_BLUE_DITHER } from 'three-gpu-pathtracer/webgpu';
import { materialStruct, surfaceRecordStruct } from 'three-gpu-pathtracer/src/webgpu/nodes/structs.wgsl.js';
import { collectRadiancePoints, type RadiancePoints } from './radianceCachePoints';

// Narrow adapter to the installed 0.0.27 WebGPU backend. No node_modules writes.
// Unsupported versions fail closed: callers retain the ordinary full path tracer.
type Backend = { _bvhData: { structs: { attributes: unknown }; fns: { getSurfaceRecord: unknown } }; _pathTracer: { rebuild(): void } };
class SurfaceCamera extends THREE.PerspectiveCamera {
  constructor(private rayFn: unknown) { super(); }
  getCameraRayFn() { return { fn: this.rayFn, update: () => false }; }
}

/** Sparse world-space E/π cache for an approximate moving-camera preview.
 * Replaces diffuse reflection at supported hits; it is not an AO multiplier.
 * Original glossy transport remains in the integrator. Misses use full shading.
 * Final settled views and exports never enable this approximation.
 */
export class PreviewRadianceCache {
  private baker: WebGPUPathTracer;
  private textures: THREE.DataTexture[] = [];
  private enabled = uniform(0);
  private radiance = texture(new THREE.Texture());
  private backend: Backend;
  private originalSurface: unknown;
  private originalSurfaceValue: unknown;
  private pending = false;
  private ticks = 0;
  private disposed = false;
  private start = performance.now();
  private minSamples = 0;
  ready = false;
  error: Error | null = null;
  readonly points: RadiancePoints;
  readonly targetSamples = 128;
  elapsedMs = 0;

  constructor(renderer: WebGPURenderer, private main: WebGPUPathTracer, scene: THREE.Scene, model: THREE.Object3D, bounds: THREE.Box3) {
    const backend = main as unknown as Backend;
    if (!backend._bvhData?.fns?.getSurfaceRecord || !backend._bvhData.structs?.attributes || !backend._pathTracer?.rebuild) throw new Error('Hybrid cache is unsupported by this path-tracer backend');
    this.backend = backend;
    // fns is a live NodeProxyObject: retaining its callable proxy would resolve
    // back to our replacement and recurse. Capture the raw backing function.
    const surfaceProxy = backend._bvhData.fns.getSurfaceRecord as { proxyObject?: { getSurfaceRecord?: unknown } };
    this.originalSurfaceValue = surfaceProxy.proxyObject?.getSurfaceRecord;
    if (!this.originalSurfaceValue) throw new Error('Unsupported surface-function proxy');
    this.originalSurface = (this.originalSurfaceValue as { functionNode?: unknown }).functionNode ?? this.originalSurfaceValue;
    this.points = collectRadiancePoints(model, bounds);
    const makeTexture = (data: Float32Array, width: number, height: number) => {
      const result = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
      result.colorSpace = THREE.NoColorSpace; result.needsUpdate = true;
      this.textures.push(result); return texture(result);
    };
    const { positions, normals, table, width, height, tableWidth, cellSize } = this.points;
    const pointsNode = makeTexture(positions, width, height), normalsNode = makeTexture(normals, width, height);
    const tableNode = makeTexture(table, tableWidth, tableWidth);
    const cell = uniform(cellSize), sampleWidth = uniform(width, 'uint');
    const bakeRay = wgslTagFn`
      fn surfaceRay(st: vec2f, resolution: vec2f, ray: ptr<function, ${rayStruct}>) -> bool {
        let pixel = clamp(vec2i(st * resolution), vec2i(0), vec2i(resolution) - 1);
        let p = textureLoad(${pointsNode}, pixel, 0).xyz;
        let n = textureLoad(${normalsNode}, pixel, 0).xyz;
        let random = ${(RANDOM_BLUE_DITHER as { rand2: unknown }).rand2}(3u);
        let r = sqrt(random.x); let phi = 6.283185307179586 * random.y;
        let tangent = normalize(cross(select(vec3f(0,1,0), vec3f(1,0,0), abs(n.y) > 0.9), n));
        let bitangent = cross(n, tangent);
        (*ray).origin = p + n * 0.003;
        (*ray).direction = normalize(n * sqrt(1.0-random.x) + tangent * (r*cos(phi)) + bitangent * (r*sin(phi)));
        (*ray).maxDist = 0.0;
        return true;
      }
    `;
    const bakeScene = scene.clone(true);
    // A camera miss during baking is world illumination, not the photographed
    // white background. Here the preset has zero world intensity.
    bakeScene.backgroundIntensity = 0;
    const originalLights: THREE.Object3D[] = [], copiedLights: THREE.Object3D[] = [];
    scene.traverse((object) => { if ((object as THREE.Light).isLight) originalLights.push(object); });
    bakeScene.traverse((object) => { if ((object as THREE.Light).isLight) copiedLights.push(object); });
    originalLights.forEach((light, index) => Object.assign(copiedLights[index], {
      isCircular: (light as THREE.Light & {isCircular?: boolean}).isCircular,
      // These are incoming-light probes, not photographed camera rays. The
      // preset hides its lamps from the camera, but probes must integrate them.
      visibleToCameraRays: true,
    }));
    this.baker = new WebGPUPathTracer(renderer);
    this.baker.setMaterial(main.getMaterial()); this.baker.setRandom(RANDOM_BLUE_DITHER);
    this.baker.synchronizeRenderSize = false; this.baker.setSize(width, height);
    this.baker.dynamicLowRes = false; this.baker.renderDelay = 0; this.baker.fadeDuration = 0; this.baker.minSamples = 0;
    this.baker.maxSamples = this.targetSamples; this.baker.maxBounces = 8; this.baker.filterGlossyFactor = 1;
    this.baker.setScene(bakeScene, new SurfaceCamera(bakeRay));
    // Bind a correctly formatted storage texture before the inactive function is
    // first compiled. The binding follows output ping-pong until baking completes.
    this.radiance.value = this.baker.target as THREE.Texture;
    const lookup = wgslTagFn`
      fn cachedDiffuse(p: vec3f, n: vec3f) -> vec4f {
        let cell = ${cell}; let coord = vec3i(floor(p / cell));
        let q = vec3u(vec3i(floor(n * 4.0 + vec3f(0.5))) + vec3i(4));
        let normalCode = q.x*81u + q.y*9u + q.z;
        let plane = i32(floor(dot(p,n)/0.01+0.5));
        let hash = (bitcast<u32>(coord.x)*73856093u) ^ (bitcast<u32>(coord.y)*19349663u) ^ (bitcast<u32>(coord.z)*83492791u) ^ (normalCode*2654435761u) ^ (bitcast<u32>(plane)*1597334677u);
        for (var probe = 0u; probe < 8u; probe++) {
          let slot = (hash + probe) & 16383u;
          let entry = textureLoad(${tableNode}, vec2i(i32(slot % 128u), i32(slot / 128u)), 0);
          if (entry.w == 0.0) { break; }
          if (any(vec3i(entry.xyz) != coord)) { continue; }
          let index = u32(entry.w) - 1u;
          let uv = vec2i(i32(index % ${sampleWidth}), i32(index / ${sampleWidth}));
          let sampleN = textureLoad(${normalsNode}, uv, 0);
          if (u32(sampleN.w) != normalCode || dot(n,sampleN.xyz) < 0.98) { continue; }
          let sampleP = textureLoad(${pointsNode}, uv, 0).xyz;
          // A nearby parallel face may be hidden behind another brick. It must
          // never supply lighting for this face merely because their cells match.
          if (abs(dot(p-sampleP,n)) > 0.003) { continue; }
          let separation = distance(p,sampleP);
          if (separation > cell * 0.45) { continue; }
          let confidence = 1.0-smoothstep(cell*0.3,cell*0.45,separation);
          return vec4f(max(textureLoad(${this.radiance}, uv, 0).rgb,vec3f(0.0)),confidence);
        }
        return vec4f(0.0);
      }
    `;
    backend._bvhData.fns.getSurfaceRecord = wgslTagFn`
      fn hybridSurface(material: ${materialStruct}, vertex: ${backend._bvhData.structs.attributes}, side: f32, faceNormal: vec3f, view: vec3f, blur: f32) -> ${surfaceRecordStruct} {
        var surface = ${this.originalSurface}(material, vertex, side, faceNormal, view, blur);
        if (${this.enabled} > 0.5 && side > 0.0 && surface.metalness < 0.01 && surface.transmission == 0.0 && surface.opacity >= 1.0 && surface.clearcoat == 0.0 && surface.sheen == 0.0 && surface.roughness < 0.6) {
          let cached = ${lookup}(vertex.position.xyz, surface.normal);
          if (cached.w > 0.0) {
            // Cosine-distributed probe rays estimate E/π. Approximate dielectric
            // diffuse energy loss; Burley angular variation remains a preview error.
            let ndv = clamp(dot(surface.normal,view),0.0,1.0);
            let diffuseEnergy = (1.0-surface.f0)*(1.0-pow(1.0-ndv,5.0));
            surface.emission += surface.color * cached.rgb * diffuseEnergy * cached.w;
            surface.color *= 1.0-cached.w;
          }
        }
        return surface;
      }
    `;
    backend._pathTracer.rebuild();
  }

  get active(): boolean { return this.enabled.value > 0.5; }
  setActive(value: boolean): boolean {
    const next = value && this.ready && !this.error;
    const changed = next !== this.active; this.enabled.value = next ? 1 : 0; return changed;
  }
  get status(): string { return this.error ? `cache unavailable: ${this.error.message}` : this.ready ? `${this.points.count} cached surface points` : `baking lighting ${Math.floor(this.minSamples)}/${this.targetSamples}`; }

  /** A few thousand surface rays, only after the main image has converged. */
  update(): void {
    if (this.disposed || this.ready || this.error) return;
    this.baker.renderSample(); this.radiance.value = this.baker.target as THREE.Texture;
    if (++this.ticks % 8 === 0 && !this.pending) {
      this.pending = true;
      void this.baker.getSampleCountsAsync().then((counts) => {
        if (this.disposed) return;
        this.minSamples = counts.min;
        if (counts.min >= this.targetSamples) { this.ready = true; this.elapsedMs = performance.now() - this.start; }
      }).catch((error) => { if (!this.disposed) this.error = new Error(String(error)); }).finally(() => { this.pending = false; });
    }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.enabled.value = 0;
    this.backend._bvhData.fns.getSurfaceRecord = this.originalSurfaceValue; this.backend._pathTracer.rebuild();
    this.baker.dispose(); for (const item of this.textures) item.dispose();
  }
}
