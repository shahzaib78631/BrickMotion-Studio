import * as THREE from 'three';
import { getColors } from '../state/partService';
import { brickHex } from './materials';

/**
 * The per-pixel buffers the learned shader (neuralShade.ts) reads besides the viewport's own frame.
 * The bricks are drawn again with flat materials, MSAA 4 like the frame:
 *   albedo  EyeSight's colour of every brick, unlit                 RGBA8 (sRGB)
 *   normal  world-space normal ×½+½, alpha 1 where a brick is       RGBA8
 *   pos     r: view distance ÷ far   g: height above the floor ÷ HEIGHT_RANGE (studs)     RGBA16F
 *   spec    r: Fresnel-like (1 - n·v)^3   g: specular response to EyeSight's BUILD_FL lights   b: mirror direction's height ½+½   RGBA8
 *           (view dependent, so the network can place highlights; the lights follow the camera heading like EyeSight's)
 * This is also exactly what the training-data exporter (src/dev/neuralExport.ts) saves.
 */
export const HEIGHT_RANGE = 64; // studs

/** EyeSight's BUILD_FL rig (settings_camera_light.xml): toward-light vectors as (right, ahead, up) and a relative strength. */
const BUILD_FL: [number, number, number, number][] = (() => {
  const raw: [number, number, number, number][] = [[-0.02431, -0.01808, 0.02612, 1.187], [-0.02278, 0.02614, 0.01995, 0.751], [0.02438, -0.00616, 0.03111, 0.751], [0.02636, 0.02253, 0.01995, 0.751]];
  return raw.map(([x, y, z, w]) => { const n = Math.hypot(x, y, z); return [x / n, y / n, z / n, w / 1.5]; });
})();

const VERTEX = /* glsl */ `
  varying vec3 vN; varying vec3 vW; varying float vView;
  void main() {
    vec3 n = normal; vec4 pos = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      n = mat3(instanceMatrix) * n; pos = instanceMatrix * pos;
    #endif
    vec4 w = modelMatrix * pos; vN = normalize(mat3(modelMatrix) * n); vW = w.xyz;
    vec4 mv = viewMatrix * w; vView = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

export class GBuffer {
  readonly albedo: THREE.WebGLRenderTarget;
  readonly normal: THREE.WebGLRenderTarget;
  readonly pos: THREE.WebGLRenderTarget;
  readonly spec: THREE.WebGLRenderTarget;
  private specMat: THREE.ShaderMaterial;
  private normalMat: THREE.ShaderMaterial;
  private posMat: THREE.ShaderMaterial;
  private albedoMats = new Map<THREE.Material, THREE.Material>();

  constructor(private renderer: THREE.WebGLRenderer, width: number, height: number) {
    const lightUniforms = { camPos: { value: new THREE.Vector3() }, lights: { value: BUILD_FL.map(() => new THREE.Vector4()) } };
    const rt = () => new THREE.WebGLRenderTarget(width, height, { samples: 4, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
    this.albedo = rt(); this.normal = rt();
    // half floats blend cleanly at antialiased edges (packed bytes do not)
    this.pos = new THREE.WebGLRenderTarget(width, height, { samples: 4, type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
    this.spec = rt();
    this.albedo.texture.colorSpace = THREE.SRGBColorSpace;
    const make = (frag: string, uniforms: Record<string, THREE.IUniform> = {}) => new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: frag, uniforms, side: THREE.DoubleSide });
    this.normalMat = make(`varying vec3 vN; varying vec3 vW; varying float vView; void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }`);
    this.specMat = make(`uniform vec3 camPos; uniform vec4 lights[4]; varying vec3 vN; varying vec3 vW; varying float vView;
      void main() {
        vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(camPos - vW);
        float nv = max(dot(n, v), 0.0);
        float fres = pow(1.0 - nv, 3.0);
        float spec = 0.0;
        for (int i = 0; i < 4; i++) { vec3 h = normalize(lights[i].xyz + v); spec += lights[i].w * pow(max(dot(n, h), 0.0), 24.0); }
        vec3 r = reflect(-v, n);
        gl_FragColor = vec4(fres, clamp(spec * 0.5, 0.0, 1.0), r.y * 0.5 + 0.5, 1.0);
      }`, lightUniforms);
    this.posMat = make(`uniform float far; uniform float hRange; varying vec3 vN; varying vec3 vW; varying float vView;
      void main(){ gl_FragColor = vec4(vView / far, vW.y / hRange, 0.0, 1.0); }`, { far: { value: 2000 }, hRange: { value: HEIGHT_RANGE } });
  }

  setSize(width: number, height: number): void {
    for (const t of [this.albedo, this.normal, this.pos, this.spec]) t.setSize(width, height);
  }

  private albedoFor(m: THREE.Material): THREE.Material {
    let a = this.albedoMats.get(m);
    if (!a) {
      const src = m as THREE.MeshPhysicalMaterial;
      const def = src.userData?.bmColor;
      const color = def && getColors().get(def.code) ? new THREE.Color(brickHex(def)) : src.color.clone();
      a = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
      this.albedoMats.set(m, a);
    }
    return a;
  }

  /**
   * Draws the three buffers. `bricks` is the model root (its meshes get flat materials for the
   * duration); everything else in the scene except lights is hidden. State is restored.
   */
  render(scene: THREE.Scene, bricks: THREE.Object3D, camera: THREE.Camera, far = 2000): void {
    const r = this.renderer;
    const meshes: THREE.Mesh[] = [];
    bricks.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const hidden = scene.children.filter((c) => c !== bricks && !(c as THREE.Light).isLight && c.visible);
    const original = new Map(meshes.map((m) => [m, m.material] as const));
    const prev = { bg: scene.background, env: scene.environment, tone: r.toneMapping, shadow: r.shadowMap.enabled, target: r.getRenderTarget(), alpha: r.getClearAlpha(), color: r.getClearColor(new THREE.Color()), auto: r.autoClear };
    (this.posMat.uniforms.far as THREE.IUniform).value = far;
    const lineVisible: THREE.Object3D[] = [];
    bricks.traverse((o) => { if (((o as THREE.Line).isLine || (o as THREE.Points).isPoints) && o.visible) { o.visible = false; lineVisible.push(o); } });
    scene.background = null; scene.environment = null;
    r.toneMapping = THREE.NoToneMapping; r.shadowMap.enabled = false; r.autoClear = true;
    for (const o of hidden) o.visible = false;
    const pass = (target: THREE.WebGLRenderTarget, clear: number, alpha: number, material: (m: THREE.Mesh) => THREE.Material) => {
      for (const m of meshes) m.material = material(m);
      r.setRenderTarget(target);
      r.setClearColor(clear, alpha);
      r.clear();
      r.render(scene, camera);
    };
    try {
      pass(this.albedo, 0xffffff, 1, (m) => this.albedoFor(original.get(m) as THREE.Material));
      pass(this.normal, 0x000000, 0, () => this.normalMat);
      pass(this.pos, 0xffffff, 1, () => this.posMat); // background: far and high (white)
      // view-dependent shine inputs: EyeSight's BUILD_FL rig turns with the camera heading
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      const ahead = new THREE.Vector3(fwd.x, 0, fwd.z); if (ahead.lengthSq() < 1e-8) ahead.set(0, 0, -1); ahead.normalize();
      const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(ahead, up);
      const u = this.specMat.uniforms;
      (u.camPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
      BUILD_FL.forEach(([x, y, z, w], i) => {
        const L = right.clone().multiplyScalar(x).addScaledVector(ahead, y).addScaledVector(up, z).normalize();
        (u.lights.value as THREE.Vector4[])[i].set(L.x, L.y, L.z, w);
      });
      pass(this.spec, 0x808080, 1, () => this.specMat);
    } finally {
      for (const m of meshes) m.material = original.get(m)!;
      for (const o of hidden) o.visible = true;
      for (const o of lineVisible) o.visible = true;
      scene.background = prev.bg; scene.environment = prev.env;
      r.toneMapping = prev.tone; r.shadowMap.enabled = prev.shadow; r.autoClear = prev.auto;
      r.setRenderTarget(prev.target); r.setClearColor(prev.color, prev.alpha);
    }
  }

  dispose(): void {
    for (const t of [this.albedo, this.normal, this.pos, this.spec]) t.dispose();
    this.normalMat.dispose(); this.posMat.dispose(); this.specMat.dispose();
    for (const m of this.albedoMats.values()) m.dispose();
  }
}
