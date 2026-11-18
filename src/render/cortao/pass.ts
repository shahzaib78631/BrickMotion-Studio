import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { cortaoParameters, cortaoPrepassParameters } from './parameters';
import { filterShader, mainShader, prepassShader, vertexShader } from './shaders';
import occluders from './occluders.json';

/** CORTAO occlusion-only reference pipeline with fragment dispatch adapters.
 * Upstream supplies no temporal filter; the documented constant-seed mode is used. */
export class CortaoPass {
  private packed = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RedIntegerFormat, type: THREE.UnsignedIntType, internalFormat: 'R32UI',
    minFilter: THREE.NearestMipmapNearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });
  private lookup = new THREE.Data3DTexture(new Uint16Array(occluders), 24, 24, 16);
  private prepass = new THREE.ShaderMaterial({
    name: 'CORTAO packed depth and normals', glslVersion: THREE.GLSL3,
    defines: { CORTAO_PERSPECTIVE_PROJECTION: 1, CORTAO_ORTHOGRAPHIC_PROJECTION: 0 },
    uniforms: { tDepth: { value: null }, tNormal: { value: null }, mipLevel: { value: 0 }, parameters: { value: null } },
    vertexShader, fragmentShader: prepassShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  private main = new THREE.ShaderMaterial({
    name: 'CORTAO circular occluders', glslVersion: THREE.GLSL3,
    defines: { CORTAO_PERSPECTIVE_PROJECTION: 1, CORTAO_ORTHOGRAPHIC_PROJECTION: 0,
      CORTAO_SAMPLE_COUNT: '16u', CORTAO_RAY_COUNT: '16u', CORTAO_OCCLUDER_LOOKUP_TABLE: 1 },
    uniforms: { packedDataBuffer: { value: this.packed.texture }, tNormal: { value: null },
      occluderLookupTable: { value: this.lookup }, parameters: { value: null }, maxMip: { value: 0 } },
    vertexShader, fragmentShader: mainShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  private raw = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private filter = new THREE.ShaderMaterial({
    name: 'CORTAO reference spatial filter', glslVersion: THREE.GLSL3,
    uniforms: { packedDataBuffer: { value: this.packed.texture }, tAO: { value: this.raw.texture }, parameters: { value: null } },
    vertexShader, fragmentShader: filterShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  private quad = new FullScreenQuad();
  private width = 0;
  private height = 0;
  private mipCount = 1;

  constructor() {
    this.lookup.format = THREE.RedIntegerFormat;
    this.lookup.type = THREE.UnsignedShortType;
    this.lookup.internalFormat = 'R16UI';
    this.lookup.minFilter = this.lookup.magFilter = THREE.NearestFilter;
    this.lookup.unpackAlignment = 1;
    this.lookup.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    depth: THREE.Texture, normal: THREE.Texture, output: THREE.WebGLRenderTarget, radius: number): void {
    const w = output.width, h = output.height;
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      // Generate the full upstream-supported chain (up to eight levels).
      this.mipCount = Math.min(8, Math.floor(Math.log2(Math.max(w, h))) + 1);
      this.raw.setSize(w, h);
      this.packed.dispose();
      this.packed.setSize(w, h);
      this.packed.texture.mipmaps = Array.from({ length: Math.floor(Math.log2(Math.max(w, h))) + 1 }, (_, level) => ({
        width: Math.max(1, w >> level), height: Math.max(1, h >> level), data: new Uint8Array(0),
      }));
    }
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const p = this.prepass.uniforms;
    p.tDepth.value = depth; p.tNormal.value = normal;
    p.parameters.value = cortaoPrepassParameters(camera, w, h, this.mipCount);
    for (const material of [this.prepass, this.main]) if (material.defines.CORTAO_PERSPECTIVE_PROJECTION !== Number(perspective)) {
      material.defines.CORTAO_PERSPECTIVE_PROJECTION = Number(perspective);
      material.defines.CORTAO_ORTHOGRAPHIC_PROJECTION = Number(!perspective);
      material.needsUpdate = true;
    }
    const state = { target: renderer.getRenderTarget(), cube: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
      autoClear: renderer.autoClear, viewport: renderer.getViewport(new THREE.Vector4()),
      scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest() };
    renderer.autoClear = false; renderer.setScissorTest(false);
    try {
      this.quad.material = this.prepass;
      for (let level = 0; level < this.mipCount; level++) {
        p.mipLevel.value = level;
        renderer.setRenderTarget(this.packed, 0, level);
        renderer.setViewport(0, 0, Math.max(1, w >> level), Math.max(1, h >> level));
        this.quad.render(renderer);
      }
      this.main.uniforms.tNormal.value = normal;
      this.main.uniforms.parameters.value = cortaoParameters(camera, w, h, radius);
      this.main.uniforms.maxMip.value = this.mipCount - 1;
      renderer.setRenderTarget(this.raw);
      renderer.setViewport(0, 0, w, h);
      this.quad.material = this.main;
      this.quad.render(renderer);
      this.filter.uniforms.parameters.value = { packedResolution: (w | h << 16) >>> 0,
        depthSensitivity: 512, normalSensitivity: 16, _padding0: 0 };
      renderer.setRenderTarget(output);
      this.quad.material = this.filter;
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(state.target, state.cube, state.mip);
      renderer.setViewport(state.viewport); renderer.setScissor(state.scissor);
      renderer.setScissorTest(state.scissorTest); renderer.autoClear = state.autoClear;
    }
  }

  readback(renderer: THREE.WebGLRenderer) {
    const raw = new Uint8Array(this.width * this.height * 4);
    renderer.readRenderTargetPixels(this.raw, 0, 0, this.width, this.height, raw);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const target = renderer.getRenderTarget();
    const cube = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const packed: Uint32Array[] = [];
    try {
      for (let level = 0; level < this.mipCount; level++) {
        const w = Math.max(1, this.width >> level), h = Math.max(1, this.height >> level);
        const data = new Uint32Array(w * h);
        renderer.setRenderTarget(this.packed, 0, level);
        gl.readPixels(0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
        packed.push(data);
      }
    } finally { renderer.setRenderTarget(target, cube, mip); }
    return { raw, packed };
  }

  dispose(): void {
    this.raw.dispose(); this.filter.dispose(); this.packed.dispose(); this.lookup.dispose(); this.prepass.dispose(); this.main.dispose(); this.quad.dispose();
  }
}
