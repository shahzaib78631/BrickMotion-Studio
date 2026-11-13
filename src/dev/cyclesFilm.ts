import * as THREE from 'three';
import { texture } from 'three/tsl';
// @ts-expect-error Runtime export used by the tracer; upstream declarations omit this helper.
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { blackmanHarrisInverseTable } from './cyclesFilmMath';

/** Only changes the camera-jitter dimension; BSDF/light random dimensions remain uniform.
 * Each camera sample is drawn from the normalized film window, so no post-blur or
 * extra image readback is needed. Numerical inverse-CDF lookup is 4 KB per tracer.
 */
export function withCyclesFilm(random: object, width: number): { random: object; dispose(): void } {
  const source = random as Record<string, unknown>;
  const samples = blackmanHarrisInverseTable(width);
  const lut = new THREE.DataTexture(samples, samples.length, 1, THREE.RedFormat, THREE.FloatType);
  lut.minFilter = lut.magFilter = THREE.NearestFilter;
  lut.generateMipmaps = false; lut.needsUpdate = true;
  const node = texture(lut);
  const inverse = wgslTagFn`
    fn filmInverseCDF(u: f32) -> f32 {
      let position = clamp(u, 0.0, 1.0) * 1024.0;
      let i = min(u32(position), 1023u);
      let a = textureLoad(${node}, vec2i(i32(i), 0), 0).r;
      let b = textureLoad(${node}, vec2i(i32(i + 1u), 0), 0).r;
      return mix(a, b, position - f32(i));
    }
  `;
  const rand2 = wgslTagFn`
    fn cyclesFilmRandom2(effect: u32) -> vec2f {
      let value = ${source.rand2}(effect);
      if (effect == 0u) {
        return vec2f(0.5 + ${inverse}(value.x), 0.5 + ${inverse}(value.y));
      }
      return value;
    }
  `;
  return { random: { ...source, rand2 }, dispose: () => lut.dispose() };
}
