/**
 * WGSL adaptation of Cycles 2.79b calculate_principled_diffuse_brdf.
 * Copyright 2011–2017 Blender Foundation. Apache-2.0.
 * Source: https://github.com/blender/blender/blob/v2.79b/intern/cycles/kernel/closure/bsdf_principled_diffuse.h
 * This ports the upstream diffuse lobe only. It is not a recovered EyeSight
 * custom shader, and the enclosing tracer's glossy layering is still glTF.
 */
import { wgslFn } from 'three/tsl';
import { surfaceRecordStruct } from 'three-gpu-pathtracer/src/webgpu/nodes/structs.wgsl.js';

// The tracer multiplies the complete BSDF by NdotL, so omit the cosine that
// Cycles includes in its closure evaluation. Keep the function a BRDF here.
export const cyclesPrincipledDiffuse = wgslFn(`
fn cyclesPrincipledDiffuse(NdotV: f32, NdotL: f32, VdotH: f32, surf: SurfaceRecord) -> vec3f {
  if (NdotV <= 0.0 || NdotL <= 0.0) { return vec3f(0.0); }
  let fl = pow(1.0 - clamp(NdotL, 0.0, 1.0), 5.0);
  let fv = pow(1.0 - clamp(NdotV, 0.0, 1.0), 5.0);
  let grazing = 0.5 + 2.0 * VdotH * VdotH * surf.roughness;
  let fd = (1.0 + (grazing - 1.0) * fl) * (1.0 + (grazing - 1.0) * fv);
  return surf.color * (fd / 3.141592653589793);
}
`, [surfaceRecordStruct]);
