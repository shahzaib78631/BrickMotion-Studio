import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

/**
 * Soft contact shadows, like drei's <ContactShadows>: a camera on the floor looks straight
 * up and draws the bricks as darkness that fades with height (`reach` studs), the result
 * is blurred twice, and a transparent plane lays it on the floor. It catches what the key
 * light's shadow misses: the soft dark pool right under and between parts that makes a
 * model sit on the surface instead of floating. Redrawn every frame, so moving parts
 * carry their own.
 */
export class ContactShadows {
  readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly blurTarget: THREE.WebGLRenderTarget;
  /** a second, much wider blur of the same shadow, blended in behind the tight one */
  private readonly wideTarget: THREE.WebGLRenderTarget;
  private readonly copyMaterial = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null as THREE.Texture | null } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }', depthTest: false, depthWrite: false });
  private readonly wide = { weight: { value: 0 }, map: { value: null as THREE.Texture | null } };
  private wideSpread = 1;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly depth: THREE.MeshDepthMaterial;
  /** clear parts: the same shadow, much fainter */
  private readonly depthClear: THREE.MeshDepthMaterial;
  private readonly clearStage = new THREE.Scene();
  private readonly clearDarkness = { value: 0.35 };
  private readonly hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  private readonly vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  private readonly quad = new FullScreenQuad();
  /** the bricks are drawn alone, through this scene's override material */
  private readonly stage = new THREE.Scene();
  private readonly uniforms = { darkness: { value: 1 }, tint: { value: new THREE.Color('#000000') } };
  private strength = 0.5;
  private blur = 2.5;
  private readonly clear = new THREE.Color();

  constructor(size = 512) {
    const rt = () => new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
    this.target = rt();
    this.blurTarget = rt();
    this.wideTarget = rt();
    this.wide.map.value = this.wideTarget.texture;
    this.target.texture.generateMipmaps = this.blurTarget.texture.generateMipmaps = this.wideTarget.texture.generateMipmaps = false;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.target.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    const wide = this.wide;
    this.plane.material.onBeforeCompile = (shader) => {
      shader.uniforms.wideMap = wide.map;
      shader.uniforms.wideWeight = wide.weight;
      shader.fragmentShader = `uniform sampler2D wideMap;\nuniform float wideWeight;\n${shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a = max(diffuseColor.a, texture2D(wideMap, vMapUv).a * wideWeight);')}`;
    };
    // the camera below looks up with +Z as its "up": a plane facing down maps its image the same way round
    this.plane.rotation.x = Math.PI / 2;
    this.plane.renderOrder = -0.5;
    this.camera.up.set(0, 0, 1);
    const make = (darkness: { value: number }) => {
      const m = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false });
      m.onBeforeCompile = (shader) => {
        shader.uniforms.darkness = darkness;
        shader.uniforms.tint = this.uniforms.tint;
        shader.fragmentShader = `uniform float darkness;\nuniform vec3 tint;\n${shader.fragmentShader.replace(
          'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          // near the floor (depth 0) fully dark, fading out by the far plane
          'gl_FragColor = vec4( tint, min( 1.0, pow( 1.0 - fragCoordZ, 1.5 ) * darkness ) );',
        )}`;
      };
      return m;
    };
    this.depth = make(this.uniforms.darkness);
    this.depthClear = make(this.clearDarkness);
    // keep the darker of the two where a clear part overlaps a solid one
    Object.assign(this.depthClear, { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
    this.clearStage.overrideMaterial = this.depthClear;
    this.stage.overrideMaterial = this.depth;
  }

  /** Shadow strength 0–1 (0 hides it), the colour it darkens towards, and the share of that strength clear parts get (0–1). */
  set(strength: number, tint: THREE.ColorRepresentation, clearShare = 0.12, wide?: { spread: number; weight: number }) {
    this.wide.weight.value = wide?.weight ?? 0;
    this.wideSpread = wide?.spread ?? 1;
    this.strength = Math.min(1, Math.max(0, strength));
    this.uniforms.tint.value.set(tint);
    // the blur thins the shadow out: draw it saturated, then let opacity set the strength
    this.plane.material.opacity = Math.min(1, this.strength * 1.1);
    this.uniforms.darkness.value = 3;
    this.clearDarkness.value = 3 * Math.min(1, Math.max(0, clearShare));
  }

  /** The wide layer: its blur as a multiple of the tight one, and how much of it shows (0 = off). */
  setWide(spread: number, weight: number) {
    this.wideSpread = spread;
    this.wide.weight.value = weight;
  }

  get on() {
    return this.strength > 0 && this.plane.visible;
  }

  /** Covers `box` (world units) on the floor at `groundY`; parts higher than `reach` above it cast nothing. */
  fitTo(box: THREE.Box3, groundY: number, reach = 2.5, spread = 1) {
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.25 + reach * 4;
    this.plane.scale.set(span, span, 1);
    this.plane.position.set(c.x, groundY + 0.003, c.z);
    const cam = this.camera;
    cam.left = cam.bottom = -span / 2;
    cam.right = cam.top = span / 2;
    cam.near = 0;
    cam.far = reach;
    cam.position.set(c.x, groundY, c.z);
    cam.lookAt(c.x, groundY + 1, c.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // the blur spreads about half a stud past the parts, whatever the model size
    this.blur = Math.max(0.8, ((0.14 * spread) / span) * this.target.width);
  }

  /** Redraws the shadow from `bricks` (moved into a private scene for the draw and put back). */
  update(renderer: THREE.WebGLRenderer, bricks: THREE.Object3D) {
    if (!this.on) return;
    const parent = bricks.parent;
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    const prevScissor = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    // Only solid parts cast. The outline edges take their per-piece placement from their
    // own material, which the override replaces, so they would all land at the model's
    // origin and darken the floor there, hidden (not yet built) pieces included.
    const lines: THREE.Object3D[] = [];
    const solid: THREE.Object3D[] = [];
    const clear: THREE.Object3D[] = [];
    bricks.traverse((o) => {
      if (!o.visible) return;
      if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints) { o.visible = false; lines.push(o); return; }
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m)) (m.transparent ? clear : solid).push(o);
    });
    const show = (list: THREE.Object3D[], on: boolean) => { for (const o of list) o.visible = on; };
    const draw = (stage: THREE.Scene, autoClear: boolean) => {
      renderer.autoClear = autoClear;
      stage.add(bricks);
      renderer.setRenderTarget(this.target);
      renderer.render(stage, this.camera);
    };
    // solid parts at full strength; clear parts (the override ignores opacity) as a faint
    // second layer, so glass still sits on the floor without a dark smudge showing through it
    show(clear, false);
    draw(this.stage, true);
    if (clear.length) {
      show(clear, true);
      show(solid, false);
      draw(this.clearStage, false);
      show(solid, true);
    }
    renderer.autoClear = true;
    parent?.add(bricks);
    for (const o of lines) o.visible = true;
    if (this.wide.weight.value > 0) {
      this.copyMaterial.uniforms.tDiffuse.value = this.target.texture;
      this.quad.material = this.copyMaterial;
      renderer.setRenderTarget(this.wideTarget);
      this.quad.render(renderer);
      for (let i = 0; i < 3; i++) {
        const spread = this.blur * this.wideSpread * (i ? 0.7 : 1);
        this.pass(renderer, this.hBlur, this.wideTarget, this.blurTarget, spread);
        this.pass(renderer, this.vBlur, this.blurTarget, this.wideTarget, spread);
      }
    }
    // two blur passes each way: target → blurTarget → target
    for (let i = 0; i < 2; i++) {
      const spread = this.blur * (i ? 0.6 : 1);
      this.pass(renderer, this.hBlur, this.target, this.blurTarget, spread);
      this.pass(renderer, this.vBlur, this.blurTarget, this.target, spread);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.setScissorTest(prevScissor);
    renderer.autoClear = prevAutoClear;
  }

  private pass(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, spread: number) {
    mat.uniforms.tDiffuse.value = from.texture;
    if (mat.uniforms.h) mat.uniforms.h.value = spread / from.width;
    if (mat.uniforms.v) mat.uniforms.v.value = spread / from.height;
    this.quad.material = mat;
    renderer.setRenderTarget(to);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.blurTarget.dispose();
    this.wideTarget.dispose();
    this.copyMaterial.dispose();
    this.depth.dispose();
    this.depthClear.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
    this.quad.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
  }
}
