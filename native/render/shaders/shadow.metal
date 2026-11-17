// The key light's shadow: a depth map seen from the light, drawn from the opaque pieces (with
// the map's own matrix, `map`: one being drawn over frames is not yet the one shown, whose
// matrix is frame.shadowProj), and read with a soft comparison filter.

struct ShadowIn {
  float3 position [[attribute(0)]];
};

vertex float4 shadowVertex(ShadowIn in [[stage_in]], uint iid [[instance_id]], constant float4x4& map [[buffer(2)]], const device InstanceData* instances [[buffer(3)]],
                           const device uint* visible [[buffer(4)]]) {
  InstanceData inst = instances[visible[iid]];
  return map * float4(placePoint(inst, in.position), 1.0);
}

// How much of the key light reaches a point: 1 lit, 0 in shadow. Outside the map is lit.
// The key is a disk of large angular radius (frame.rig.y), so a shadow's edge widens with the
// distance from what casts it to what receives it (percentage-closer soft shadows, Fernando
// 2005): first the casters' mean depth around the point, then a filter that wide.
//
// Each tap is compared with the receiver's own plane carried out to it (receiver-plane depth
// bias), not with the point's depth: a face tilted to the light is not taken for its own
// caster, and a caster low beside a point still counts. The taps lie on a unit disk (Vogel's
// spiral), turned by `turn`; the caller turns it differently from pixel to neighbouring pixel
// and smooths the result.
float keyShadow(float3 world, float3 n, constant FrameUniforms& frame, depth2d<float> shadowMap, sampler shadowSampler, float turn) {
  float texelLdu = frame.floorPlane.z;
  float3 rowX = float3(frame.shadowProj[0][0], frame.shadowProj[1][0], frame.shadowProj[2][0]);
  float3 rowY = float3(frame.shadowProj[0][1], frame.shadowProj[1][1], frame.shadowProj[2][1]);
  float3 rowZ = float3(frame.shadowProj[0][2], frame.shadowProj[1][2], frame.shadowProj[2][2]);
  float lduPerDepth = 1.0 / length(rowZ);
  float3 l = -rowZ * lduPerDepth;  // toward the light
  float3 across = normalize(rowX), down = -normalize(rowY);  // the map's +u and +v, in the world
  // Pushed out a little along the normal, so the point is not inside its own face.
  float3 p = world + n * (texelLdu * frame.floorPlane.w + 0.5);
  float4 c = frame.shadowProj * float4(p, 1.0);
  float2 uv = float2(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < 0.0) || any(uv > 1.0) || c.z > 1.0) return 1.0;
  float2 texel = 1.0 / float2(shadowMap.get_width(), shadowMap.get_height());
  // Depth of the receiver's plane per LDU across the map, and a constant LDU of slack.
  float facing = max(dot(n, l), 0.15);
  float2 slope = float2(-dot(n, across), -dot(n, down)) / facing / lduPerDepth;  // depth toward the light per LDU across
  float slack = 1.0 / lduPerDepth;
  float tanRadius = sqrt(frame.rig.y / max(1.0 - frame.rig.y, 1e-4));
  float ct = cos(turn), st = sin(turn);
  constexpr sampler raw(filter::nearest, address::clamp_to_edge);
  // The casters within reach: as far across as a caster maxPenumbra above could blur.
  const float maxPenumbra = 64.0;  // LDU
  float search = maxPenumbra * tanRadius / texelLdu;
  float blockers = 0, count = 0;
  for (int i = 0; i < 16; i++) {
    float r = sqrt((float(i) + 0.5) / 16.0), a = float(i) * 2.39996323;
    float2 d = r * float2(cos(a) * ct - sin(a) * st, sin(a) * ct + cos(a) * st);
    float2 off = d * search;
    float plane = c.z - dot(slope, off * texelLdu) - slack;
    float z = shadowMap.sample(raw, uv + off * texel);
    if (z < plane) blockers += plane - z, count += 1;
  }
  if (count == 0) return 1.0;
  float gap = blockers / count * lduPerDepth;  // LDU from the casters to this point
  float width = clamp(gap * tanRadius / texelLdu, 1.0, search);
  float sum = 0;
  for (int i = 0; i < 16; i++) {
    float r = sqrt((float(i) + 0.5) / 16.0), a = float(i) * 2.39996323;
    float2 off = r * float2(cos(a) * ct - sin(a) * st, sin(a) * ct + cos(a) * st) * width;
    sum += shadowMap.sample_compare(shadowSampler, uv + off * texel, c.z - dot(slope, off * texelLdu) - slack);
  }
  return sum / 16.0;
}
