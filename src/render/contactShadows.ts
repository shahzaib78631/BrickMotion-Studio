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
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly depth: THREE.MeshDepthMaterial;
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
    this.target.texture.generateMipmaps = this.blurTarget.texture.generateMipmaps = false;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.target.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    // the camera below looks up with +Z as its "up": a plane facing down maps its image the same way round
    this.plane.rotation.x = Math.PI / 2;
    this.plane.renderOrder = -0.5;
    this.camera.up.set(0, 0, 1);
    this.depth = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false });
    this.depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.uniforms.darkness;
      shader.uniforms.tint = this.uniforms.tint;
      shader.fragmentShader = `uniform float darkness;\nuniform vec3 tint;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        // near the floor (depth 0) fully dark, fading out by the far plane
        'gl_FragColor = vec4( tint, min( 1.0, pow( 1.0 - fragCoordZ, 1.5 ) * darkness ) );',
      )}`;
    };
    this.stage.overrideMaterial = this.depth;
  }

  /** Shadow strength 0–1 (0 hides it), and the colour it darkens towards. */
  set(strength: number, tint: THREE.ColorRepresentation) {
    this.strength = Math.min(1, Math.max(0, strength));
    this.uniforms.tint.value.set(tint);
    // the blur thins the shadow out: draw it saturated, then let opacity set the strength
    this.plane.material.opacity = Math.min(1, this.strength * 1.1);
    this.uniforms.darkness.value = 3;
  }

  get on() {
    return this.strength > 0 && this.plane.visible;
  }

  /** Covers `box` (world units) on the floor at `groundY`; parts higher than `reach` above it cast nothing. */
  fitTo(box: THREE.Box3, groundY: number, reach = 2.5) {
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
    this.blur = Math.max(0.8, (0.14 / span) * this.target.width);
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
    this.stage.add(bricks);
    renderer.setRenderTarget(this.target);
    renderer.render(this.stage, this.camera);
    parent?.add(bricks);
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
    this.depth.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
    this.quad.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
  }
}
