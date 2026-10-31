import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** How strong and how wide the ambient occlusion is (world units: 1 = one stud). */
export type AOSettings = { intensity: number; radius: number };

/** Half-width of the fake rounded edge, in studs (a real brick's is about 0.02). */
const BEVEL_STUDS = 0.022;

/**
 * Screen-space finishing over an already rendered frame:
 *
 * - Ground-truth ambient occlusion: the soft darkening where a part meets the floor and in
 *   the corners between parts that path-traced product renders have and a single shadow map
 *   cannot give.
 * - Rounded edges: LDraw parts have perfectly sharp corners, real bricks have tiny rounded
 *   ones that catch a thin bright line. Wherever two faces meet at a convex corner, a line a
 *   bevel wide is lit as if its normal were halfway between the faces. Inside corners, part
 *   silhouettes and seams between parts are left alone. It is a fake, not real geometry.
 *
 * The frame itself is rendered exactly as before (tone mapping, backdrop, MSAA); this only
 * multiplies the occlusion over it and adds the edge light, so scene colours stay as authored.
 */
export class StudioAO {
  private pass: GTAOPass;
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;
  private perspective = true;
  private width = 1;
  private height = 1;
  private aoIntensity = 0;
  private edgeStrength = 0;
  private internals: {
    _overrideVisibility(): void;
    _restoreVisibility(): void;
    _renderOverride(r: THREE.WebGLRenderer, m: THREE.Material, t: THREE.WebGLRenderTarget, c: number, a: number): void;
    normalMaterial: THREE.Material;
    normalRenderTarget: THREE.WebGLRenderTarget;
  };

  /** `include`: the only scene children that cast or receive occlusion (bricks and floors, never editor helpers). */
  constructor(scene: THREE.Scene, camera: THREE.Camera, private include: () => THREE.Object3D[]) {
    this.pass = new GTAOPass(scene, camera, 1, 1);
    this.pass.output = GTAOPass.OUTPUT.Off;
    this.pass.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1, samples: 24, distanceFallOff: 1 });
    this.pass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 8, rings: 2, samples: 16 });
    // Only the listed objects take part. Helpers, gizmos, markers and lights stay out of the G-buffer.
    this.internals = this.pass as unknown as StudioAO['internals'];
    const hidden: THREE.Object3D[] = [];
    this.internals._overrideVisibility = () => {
      const keep = new Set(this.include());
      for (const child of scene.children) if (child.visible && !keep.has(child)) { child.visible = false; hidden.push(child); }
      for (const obj of keep) obj.traverse((o) => {
        if (((o as THREE.Line).isLine || (o as THREE.Points).isPoints) && o.visible) { o.visible = false; hidden.push(o); }
      });
    };
    this.internals._restoreVisibility = () => {
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tAO: { value: null }, tDepth: { value: null }, tNormal: { value: null },
        intensity: { value: 0 }, edge: { value: 0 }, bevel: { value: BEVEL_STUDS },
        texel: { value: new THREE.Vector2(1, 1) }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
        projInv: { value: new THREE.Matrix4() }, viewToWorld: { value: new THREE.Matrix3() }, pxPerUnit: { value: 1 }, lightDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      defines: { PERSPECTIVE_CAMERA: 1 },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tAO; uniform sampler2D tDepth; uniform sampler2D tNormal;
        uniform float intensity; uniform float edge; uniform float bevel;
        uniform vec2 texel; uniform float cameraNear; uniform float cameraFar;
        uniform mat4 projInv; uniform float pxPerUnit; uniform vec3 lightDir; uniform mat3 viewToWorld;
        varying vec2 vUv;
        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          #if PERSPECTIVE_CAMERA == 1
            return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
          #else
            return -orthographicDepthToViewZ(d, cameraNear, cameraFar);
          #endif
        }
        vec3 viewPos(vec2 uv, float d) {
          vec4 p = projInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
          return p.xyz / p.w;
        }
        vec3 viewNormal(vec2 uv) { return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0); }

        // GTAO leaves a fine per-pixel grain that a video encoder turns into speckle. A blur that
        // stays on one surface (same depth, same facing) smooths it without smudging contact
        // shadow across the edge of a part. Upright faces keep only a trace of occlusion: in
        // product renders the darkening pools on the floor and tops, the sides of a brick stay
        // clean. A gentle curve then keeps the open floor clean and deepens only true contact.
        float occlusion(float z0) {
          if (intensity <= 0.0) return 1.0;
          vec3 n0 = viewNormal(vUv);
          float sum = 0.0, wsum = 0.0;
          for (int y = -4; y <= 4; y++) for (int x = -4; x <= 4; x++) {
            vec2 o = vec2(float(x), float(y));
            vec2 uv = vUv + o * texel * 1.5;
            float z = viewZ(uv);
            float wz = max(0.0, 1.0 - abs(z - z0) / (0.015 * z0));
            float wn = pow(max(dot(n0, viewNormal(uv)), 0.0), 16.0);
            float w = exp(-dot(o, o) / 12.0) * wz * wn;
            sum += clamp(texture2D(tAO, uv).r, 0.0, 1.0) * w;
            wsum += w;
          }
          float ao = wsum > 0.0 ? sum / wsum : clamp(texture2D(tAO, vUv).r, 0.0, 1.0);
          float up = (viewToWorld * n0).y;
          float k = intensity * mix(0.25, 1.0, smoothstep(0.35, 0.85, up));
          // A surface seen nearly edge-on (the far floor from a low camera) gets almost no
          // depth detail per pixel, and GTAO reads it as occluded: a dark band at the horizon.
          #if PERSPECTIVE_CAMERA == 1
            vec3 toEye = -normalize(viewPos(vUv, texture2D(tDepth, vUv).x));
          #else
            vec3 toEye = vec3(0.0, 0.0, 1.0);
          #endif
          k *= smoothstep(0.06, 0.3, abs(dot(n0, toEye)));
          return mix(1.0, pow(ao, 1.35), k);
        }

        // Light on a fake rounded corner: look a bevel's width around; where a neighbour lies on
        // another face that falls away from this one (a convex corner) and both faces carry on
        // for a while (a real corner, not the letters of a stud logo), the corner glints where
        // the normal halfway between the faces turns towards the key light. Subtle on purpose:
        // in product renders a rounded edge reads as softness, not as a drawn line.
        float roundedEdge(float d0) {
          if (edge <= 0.0 || d0 >= 1.0) return 0.0;
          vec3 p0 = viewPos(vUv, d0);
          vec3 n0 = viewNormal(vUv);
          float z0 = -p0.z;
          #if PERSPECTIVE_CAMERA == 1
            float scale = pxPerUnit / z0;
          #else
            float scale = pxPerUnit;
          #endif
          float r = clamp(bevel * scale, 0.75, 2.5);
          // faces must continue this far (about 2 LDU) on both sides of the corner
          float extent = clamp(0.1 * scale, 2.0, 24.0);
          float reach = max(bevel * 8.0, 4.0 * r / scale);
          float hits = 0.0;
          vec3 bent = vec3(0.0);
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7853982;
            vec2 dir = vec2(cos(a), sin(a)) * texel;
            vec2 uv = vUv + dir * r;
            float d1 = texture2D(tDepth, uv).x;
            if (d1 >= 1.0) continue;
            vec3 p1 = viewPos(uv, d1);
            vec3 dp = p1 - p0;
            float len = length(dp);
            // another part far behind (a silhouette), or the very same point: no corner here
            if (len > reach || len < 1e-6) continue;
            vec3 n1 = viewNormal(uv);
            float bend = smoothstep(0.12, 0.45, 1.0 - dot(n0, n1));
            float convex = smoothstep(0.02, 0.15, -dot(n0, dp / len));
            if (bend * convex <= 0.0) continue;
            float far1 = dot(viewNormal(vUv + dir * (r + extent)), n1);
            float far0 = dot(viewNormal(vUv - dir * extent), n0);
            float w = bend * convex * smoothstep(0.9, 0.98, far1) * smoothstep(0.9, 0.98, far0);
            hits += w;
            bent += (n0 + n1) * w;
          }
          float e = clamp(hits / 2.5, 0.0, 1.0);
          if (e <= 0.0) return 0.0;
          vec3 n = normalize(bent);
          vec3 v = normalize(-p0);
          // only the part of the bevel that turns towards the light is brighter than its faces
          float lit = max(dot(n, lightDir), 0.0) - max(max(dot(n0, lightDir), 0.0), 0.0) * 0.6;
          float spec = pow(max(dot(reflect(-v, n), lightDir), 0.0), 16.0);
          return edge * e * (max(lit, 0.0) * 0.6 + spec);
        }

        void main() {
          float d0 = texture2D(tDepth, vUv).x;
          // rgb is added, alpha multiplies what is on screen: frame * ao + edge light
          gl_FragColor = vec4(vec3(roundedEdge(d0)), occlusion(viewZ(vUv)));
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      // leave the frame's alpha alone
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Drawing-buffer pixels of the area the frame covers. */
  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.pass.setSize(w, h);
  }

  set(settings: AOSettings): void {
    this.aoIntensity = settings.intensity;
    this.pass.updateGtaoMaterial({ radius: settings.radius });
  }

  /** Strength of the rounded-edge light (0 = sharp LDraw corners). */
  setRoundedEdges(strength: number): void {
    this.edgeStrength = strength;
    this.material.uniforms.edge.value = strength;
  }

  /** Whether there is anything to draw; `ao` false leaves the occlusion out. */
  active(ao: boolean): boolean {
    return (ao && this.aoIntensity > 0) || this.edgeStrength > 0;
  }

  /**
   * Call right after the frame was drawn, with the same camera, viewport and scissor still set.
   * `light`: world direction towards the key light. `ao` false leaves the occlusion out.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, light: THREE.Vector3, ao = true): void {
    const pass = this.pass;
    if (pass.camera !== camera || this.perspective !== camera instanceof THREE.PerspectiveCamera) {
      pass.camera = camera;
      this.perspective = camera instanceof THREE.PerspectiveCamera;
      pass.gtaoMaterial.defines.PERSPECTIVE_CAMERA = this.perspective ? 1 : 0;
      pass.gtaoMaterial.needsUpdate = true;
    }
    const useAO = ao && this.aoIntensity > 0;
    // the normal/depth pre-pass must not redraw the shadow maps the frame just used
    const shadows = renderer.shadowMap.autoUpdate;
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    renderer.shadowMap.autoUpdate = false;
    try {
      if (useAO) {
        pass.render(renderer, null as unknown as THREE.WebGLRenderTarget, null as unknown as THREE.WebGLRenderTarget, 0, false);
      } else {
        // the edges only need normals and depth
        const g = this.internals;
        g._overrideVisibility();
        g._renderOverride(renderer, g.normalMaterial, g.normalRenderTarget, 0x7777ff, 1.0);
        g._restoreVisibility();
      }
    } finally {
      renderer.shadowMap.autoUpdate = shadows;
    }
    renderer.setRenderTarget(null);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    const u = this.material.uniforms;
    u.intensity.value = useAO ? this.aoIntensity : 0;
    u.tAO.value = pass.pdRenderTarget.texture;
    u.tDepth.value = pass.depthTexture;
    u.tNormal.value = this.internals.normalRenderTarget.texture;
    u.texel.value.set(1 / this.width, 1 / this.height);
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.projInv.value.copy(camera.projectionMatrixInverse);
    // pixels per world unit: at a depth of 1 for a perspective camera, anywhere for an orthographic one
    u.pxPerUnit.value = camera.projectionMatrix.elements[5] * this.height / 2;
    u.lightDir.value.copy(light).transformDirection(camera.matrixWorldInverse);
    u.viewToWorld.value.setFromMatrix4(camera.matrixWorld);
    if (this.material.defines.PERSPECTIVE_CAMERA !== (this.perspective ? 1 : 0)) {
      this.material.defines.PERSPECTIVE_CAMERA = this.perspective ? 1 : 0;
      this.material.needsUpdate = true;
    }
    // drawing the quad must not clear the finished frame it lights
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      this.quad.render(renderer);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.pass.dispose();
    this.quad.dispose();
    this.material.dispose();
  }
}
