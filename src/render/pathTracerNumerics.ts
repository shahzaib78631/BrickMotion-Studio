import type * as THREE from 'three';
import type { WebGLPathTracer } from 'three-gpu-pathtracer';

/** Compatibility fix for three-gpu-pathtracer 0.0.27. GLSL pow is undefined
 * for negative bases, including the IOR > 1 exit interface. Normalized dot
 * products can also exceed one by a rounding error. Keep Fresnel finite without
 * changing the physical model or discarding invalid light samples. */
export function finiteFresnelShader(source: string): string {
  return source
    .replace('return pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 );',
      'float r = ( 1.0 - eta ) / ( 1.0 + eta ); return r * r;')
    .replaceAll('sqrt( 1.0 - cosTheta * cosTheta )', 'sqrt( max( 0.0, 1.0 - cosTheta * cosTheta ) )')
    .replace('float sinThetaISq = 1.0f - cosThetaI * cosThetaI;',
      'float sinThetaISq = max( 0.0, 1.0 - cosThetaI * cosThetaI );')
    .replaceAll('pow( 1.0 - cosine, 5.0 )', 'pow( max( 0.0, 1.0 - cosine ), 5.0 )');
}

export function stabilizePathTracer(tracer: WebGLPathTracer): void {
  // This dependency exposes no public shader accessor. Keep the version-specific
  // access here so a library upgrade has a single compatibility boundary.
  const material = (tracer as unknown as { _pathTracer: { material: THREE.ShaderMaterial } })._pathTracer.material;
  const patched = finiteFresnelShader(material.fragmentShader);
  if (patched !== material.fragmentShader) {
    material.fragmentShader = patched;
    material.needsUpdate = true;
  }
}
