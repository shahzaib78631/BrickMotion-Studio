// The key light's shadow: a depth map seen from the light (frame.shadowProj), drawn from the
// opaque pieces before the frame, and read with a 3 x 3 comparison filter.

struct ShadowIn {
  float3 position [[attribute(0)]];
};

vertex float4 shadowVertex(ShadowIn in [[stage_in]], uint iid [[instance_id]], constant FrameUniforms& frame [[buffer(1)]], const device InstanceData* instances [[buffer(3)]],
                           const device uint* visible [[buffer(4)]]) {
  InstanceData inst = instances[visible[iid]];
  return frame.shadowProj * float4(placePoint(inst, in.position), 1.0);
}

// How much of the key light reaches a point: 1 lit, 0 in shadow. Outside the map is lit.
float keyShadow(float3 world, float3 n, constant FrameUniforms& frame, depth2d<float> shadowMap, sampler shadowSampler) {
  // Pushed out along the normal by a few texels, so a face does not shadow itself.
  float3 p = world + n * (frame.floorPlane.z * frame.floorPlane.w);
  float4 c = frame.shadowProj * float4(p, 1.0);
  float2 uv = float2(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < 0.0) || any(uv > 1.0) || c.z > 1.0) return 1.0;
  float2 texel = 1.0 / float2(shadowMap.get_width(), shadowMap.get_height());
  float sum = 0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) sum += shadowMap.sample_compare(shadowSampler, uv + float2(x, y) * texel, c.z);
  return sum / 9.0;
}
