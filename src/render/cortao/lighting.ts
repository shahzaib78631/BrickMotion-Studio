import * as THREE from 'three';

// Shared materials can be rendered by several studios. Bind the current view's
// AO just before its beauty pass and disable it for auxiliary/reflection draws.
const uniforms = {
  bmCortaoEnabled: { value: false }, bmCortaoMap: { value: null as THREE.Texture | null },
  bmCortaoWide: { value: null as THREE.Texture | null }, bmCortaoViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
  bmCortaoStrength: { value: 1 }, bmCortaoWideStrength: { value: 0 },
};
let boundCamera: THREE.Camera | null = null;
let active = false;
export function bindCortaoLighting(tight: THREE.Texture | null, wide: THREE.Texture | null = null,
  viewport = new THREE.Vector4(0, 0, 1, 1), strength = 1, wideStrength = 0, camera: THREE.Camera | null = null) {
  active = tight !== null; boundCamera = camera;
  uniforms.bmCortaoEnabled.value = tight !== null;
  uniforms.bmCortaoMap.value = tight;
  uniforms.bmCortaoWide.value = wide ?? tight;
  uniforms.bmCortaoViewport.value.copy(viewport);
  uniforms.bmCortaoStrength.value = strength;
  uniforms.bmCortaoWideStrength.value = wideStrength;
}
export function cortaoLightingShader(shader: Parameters<THREE.Material['onBeforeCompile']>[0]) {
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = `
    uniform bool bmCortaoEnabled;
    uniform sampler2D bmCortaoMap;
    uniform sampler2D bmCortaoWide;
    uniform vec4 bmCortaoViewport;
    uniform float bmCortaoStrength;
    uniform float bmCortaoWideStrength;
  ` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
    #include <aomap_fragment>
    if (bmCortaoEnabled) {
      vec2 bmAoUV = (gl_FragCoord.xy - bmCortaoViewport.xy) / bmCortaoViewport.zw;
      float bmAO = max(0.0, mix(1.0, texture2D(bmCortaoMap, bmAoUV).r, bmCortaoStrength));
      bmAO *= max(0.0, mix(1.0, texture2D(bmCortaoWide, bmAoUV).r, bmCortaoWideStrength));
      // Visibility affects indirect lighting in linear HDR, before tone mapping.
      reflectedLight.indirectDiffuse *= bmAO;
      #ifdef USE_CLEARCOAT
        clearcoatSpecularIndirect *= bmAO;
      #endif
      #ifdef USE_SHEEN
        sheenSpecularIndirect *= bmAO;
      #endif
      #if defined(USE_ENVMAP) && defined(STANDARD)
        reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), bmAO, material.roughness);
      #endif
    }
  `);
}
/** Prevent the primary camera's screen texture from leaking into reflections. */
export function installCortaoDraw(material: THREE.Material) {
  const before = material.onBeforeRender;
  material.onBeforeRender = function(renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    uniforms.bmCortaoEnabled.value = active && camera === boundCamera;
  };
}
/** Wrap a floor material's existing shader customization. */
export function installCortaoLighting(material: THREE.Material) {
  installCortaoDraw(material);
  const before = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) { before.call(this, shader, renderer); cortaoLightingShader(shader); };
  material.customProgramCacheKey = () => key + '|cortao-indirect-v1';
}
