import * as THREE from 'three';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { texture, uv, vec2, vec3, positionWorld, length, smoothstep, float } from 'three/tsl';
// @ts-expect-error Runtime helper omitted from upstream declarations.
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { WebGPUPathTracer, RANDOM_BLUE_DITHER } from 'three-gpu-pathtracer/webgpu';

/** Cached empty-floor ratio, with a geometry/depth mask, composited in linear light.
 * This is a shadow-ground presentation layer, not EyeSight's internal catcher port.
 * The reference is low resolution because an empty floor has no geometric detail.
 * Camera/light changes invalidate it; no image readback is used during presentation.
 */
export class ShadowGround {
  private reference: WebGPUPathTracer;
  private referenceScene = new THREE.Scene();
  private referenceFloor: THREE.Mesh;
  private referenceLights: THREE.Light[];
  private maskScene = new THREE.Scene();
  private maskTarget: THREE.RenderTarget;
  private baselineTarget: THREE.RenderTarget;
  private baselineMaterial = new MeshBasicNodeMaterial();
  private baselineQuad: QuadMesh;
  private baselineSource = texture(new THREE.Texture());
  private baselineDirty = true;
  private maskModel: THREE.Object3D;
  private maskLinks: [THREE.Object3D, THREE.Object3D][] = [];
  private maskFloor: THREE.Mesh;
  private modelMaterial = new MeshBasicNodeMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
  private floorMaterial = new MeshBasicNodeMaterial({ color: 0xff0000, side: THREE.DoubleSide });
  private quadMaterial = new MeshBasicNodeMaterial();
  private quad: QuadMesh;
  private maskDisplayMaterial = new MeshBasicNodeMaterial();
  private maskDisplay: QuadMesh;
  private imageNode = texture(new THREE.Texture());
  private floorNode = texture(new THREE.Texture());
  private maskNode;
  private dirty = true;
  private frames = 0;
  private pending = false;
  private generation = 0;
  ready = false;

  constructor(private renderer: WebGPURenderer, private scene: THREE.Scene, model: THREE.Object3D,
    private floor: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, private lights: THREE.Light[],
    private camera: THREE.Camera, width: number, height: number, materialModel: unknown, modelBounds?: THREE.Box3) {
    this.referenceFloor = floor.clone();
    this.referenceFloor.material = floor.material.clone();
    this.referenceScene.add(this.referenceFloor);
    this.referenceLights = lights.map((light) => Object.assign(light.clone(), { isCircular: (light as THREE.Light & { isCircular?: boolean }).isCircular }));
    this.referenceScene.add(...this.referenceLights);
    this.reference = new WebGPUPathTracer(renderer);
    this.reference.setMaterial(materialModel);
    this.reference.filterGlossyFactor = 1;
    this.reference.synchronizeRenderSize = false;
    this.reference.setSize(Math.max(16, Math.round(width / 4)), Math.max(16, Math.round(height / 4)));
    this.reference.dynamicLowRes = false;
    this.reference.renderDelay = 0; this.reference.fadeDuration = 0; this.reference.minSamples = 0;
    this.reference.maxBounces = 2; this.reference.maxSamples = 64;
    this.reference.setRandom(RANDOM_BLUE_DITHER);
    this.baselineTarget = new THREE.RenderTarget(Math.max(16, Math.round(width / 4)), Math.max(16, Math.round(height / 4)), { type: THREE.HalfFloatType });
    // The empty distant-lit floor is a smooth field. Filter its Monte Carlo noise
    // once per invalidation, before division; never blur the model or its shadows.
    const smoothBaseline = wgslTagFn`
      fn smoothGround(st: vec2f) -> vec3f {
        let sz = vec2i(textureDimensions(${this.baselineSource}));
        let p = vec2i(st * vec2f(sz));
        var sum = vec3f(0.0); var weight = 0.0;
        for (var y = -6; y <= 6; y++) {
          for (var x = -6; x <= 6; x++) {
            let w = exp(-f32(x*x+y*y)/18.0);
            sum += textureLoad(${this.baselineSource}, clamp(p + vec2i(x,y), vec2i(0), sz-1), 0).rgb*w;
            weight += w;
          }
        }
        return sum / weight;
      }
    `;
    this.baselineMaterial.colorNode = smoothBaseline(uv());
    this.baselineMaterial.toneMapped = false;
    this.baselineQuad = new QuadMesh(this.baselineMaterial);
    this.maskModel = model.clone(true);
    const sourceObjects: THREE.Object3D[] = [], maskObjects: THREE.Object3D[] = [];
    model.traverse((object) => sourceObjects.push(object));
    this.maskModel.traverse((object) => maskObjects.push(object));
    this.maskLinks = sourceObjects.map((object, index) => [object, maskObjects[index]]);
    this.maskModel.traverse((object) => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).material = this.modelMaterial; });
    this.maskFloor = floor.clone(); this.maskFloor.material = this.floorMaterial;
    // Far from the assembly there is no useful contact-shadow signal. Fade the
    // ratio to the white backdrop so finite floor edges cannot form a horizon.
    const bounds = modelBounds ?? new THREE.Box3().setFromObject(model);
    const origin = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2);
    const distance = length(positionWorld.xz.sub(vec2(origin.x, origin.z)));
    this.floorMaterial.colorNode = vec3(float(1).sub(smoothstep(radius * 4, radius * 8, distance)), 0, 0);
    this.maskScene.add(this.maskModel, this.maskFloor);
    this.maskScene.background = new THREE.Color(0);
    this.maskTarget = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    this.maskNode = texture(this.maskTarget.texture);
    // Storage textures may be unfilterable rgba32float: use explicit bilinear loads.
    const sample = wgslTagFn`
      fn groundBilinear(t: texture_2d<f32>, st: vec2f) -> vec4f {
        let sz = vec2i(textureDimensions(t));
        let p = st * vec2f(sz) - vec2f(0.5);
        let base = vec2i(floor(p)); let f = fract(p);
        let a = textureLoad(t, clamp(base, vec2i(0), sz - 1), 0);
        let b = textureLoad(t, clamp(base + vec2i(1, 0), vec2i(0), sz - 1), 0);
        let c = textureLoad(t, clamp(base + vec2i(0, 1), vec2i(0), sz - 1), 0);
        let d = textureLoad(t, clamp(base + vec2i(1), vec2i(0), sz - 1), 0);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
    `;
    const compose = wgslTagFn`
      fn shadowGround(st: vec2f) -> vec3f {
        let image = ${sample}(${this.imageNode}, st).rgb;
        let emptyFloor = ${sample}(${this.floorNode}, st).rgb;
        let mask = ${sample}(${this.maskNode}, st).rg;
        let ratio = select(vec3f(1.0), clamp(image / max(emptyFloor, vec3f(0.0001)), vec3f(0.0), vec3f(1.0)), emptyFloor > vec3f(0.0001));
        let background = mix(vec3f(1.0), ratio, clamp(mask.r, 0.0, 1.0));
        return mix(background, image, clamp(mask.g, 0.0, 1.0));
      }
    `;
    this.quadMaterial.colorNode = compose(uv());
    this.quadMaterial.depthTest = false; this.quadMaterial.depthWrite = false;
    this.quad = new QuadMesh(this.quadMaterial);
    this.maskDisplayMaterial.colorNode = sample(this.maskNode, uv()).rgb;
    this.maskDisplay = new QuadMesh(this.maskDisplayMaterial);
    this.invalidate(true);
  }

  invalidate(sceneChanged = false): void {
    this.generation++; this.ready = false; this.frames = 0; this.dirty = true; this.baselineDirty = true;
    this.referenceScene.environment = this.scene.environment;
    this.referenceScene.environmentIntensity = this.scene.environmentIntensity;
    this.referenceScene.environmentRotation.copy(this.scene.environmentRotation);
    this.referenceScene.background = this.scene.background;
    this.referenceScene.backgroundIntensity = this.scene.backgroundIntensity;
    this.referenceFloor.matrix.copy(this.floor.matrix); this.referenceFloor.position.copy(this.floor.position);
    this.referenceFloor.quaternion.copy(this.floor.quaternion); this.referenceFloor.scale.copy(this.floor.scale);
    (this.referenceFloor.material as THREE.MeshStandardMaterial).copy(this.floor.material);
    this.lights.forEach((light, i) => {
      this.referenceLights[i].copy(light); this.referenceLights[i].updateMatrixWorld(true);
    });
    if (sceneChanged) this.reference.setScene(this.referenceScene, this.camera);
    else { this.reference.updateTransforms(); this.reference.updateEnvironment(); this.reference.updateLights(); this.reference.updateCamera(); }
    this.referenceScene.updateMatrixWorld(true);
  }

  /** Run before the main tracer, which presents over the reference's temporary blit. */
  invalidateModel(): void { this.dirty = true; }

  update(): void {
    if (this.ready) return;
    this.reference.renderSample(); this.frames++;
    if (this.frames % 8 === 0 && !this.pending) {
      this.pending = true; const generation = this.generation;
      void this.reference.getSampleCountsAsync().then((counts) => {
        if (generation === this.generation && counts.min >= 64) this.ready = true;
      }).catch((error) => { console.warn('Shadow-ground sample query failed', error); }).finally(() => { this.pending = false; });
    }
  }

  render(image: THREE.Texture): void {
    if (!this.ready || !this.reference.target) return;
    if (this.baselineDirty) {
      const previous = this.renderer.getRenderTarget();
      this.baselineSource.value = this.reference.target as THREE.Texture;
      this.renderer.setRenderTarget(this.baselineTarget);
      this.baselineQuad.render(this.renderer);
      this.renderer.setRenderTarget(previous); this.baselineDirty = false;
    }
    if (this.dirty) {
      for (const [source, target] of this.maskLinks) {
        if (source.matrixAutoUpdate) source.updateMatrix();
        target.matrixAutoUpdate = false;
        target.matrix.copy(source.matrix); target.visible = source.visible;
      }
      this.maskFloor.position.copy(this.floor.position);
      const previous = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.maskTarget);
      this.renderer.render(this.maskScene, this.camera);
      this.renderer.setRenderTarget(previous); this.dirty = false;
    }
    this.imageNode.value = image;
    this.floorNode.value = this.baselineTarget.texture;
    this.quad.render(this.renderer);
  }

  /** Diagnostic-only display; callers capture in-frame and immediately restore render(). */
  showMask(): void { this.maskDisplay.render(this.renderer); }

  dispose(): void {
    this.reference.dispose(); this.maskTarget.dispose(); this.baselineTarget.dispose();
    this.baselineMaterial.dispose();
    (this.referenceFloor.material as THREE.Material).dispose();
    this.modelMaterial.dispose(); this.floorMaterial.dispose(); this.quadMaterial.dispose(); this.maskDisplayMaterial.dispose();
  }
}
