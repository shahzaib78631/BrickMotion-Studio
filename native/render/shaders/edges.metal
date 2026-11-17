// Outline lines: each mesh's edges, drawn for every instance shown at full or low detail, a
// little nearer the eye than the faces they lie on, in the material's edge colour. They fade
// out as studs get small on screen (bmr::cull leaves out those already gone): far off, lines a
// pixel wide would cover a piece (black's edges are light grey).

struct EdgeOut {
  float4 position [[position]];
  float fade;
};

vertex EdgeOut edgeVertex(uint vid [[vertex_id]], uint iid [[instance_id]], const device packed_float3* points [[buffer(0)]], constant FrameUniforms& frame [[buffer(1)]],
                          constant DrawUniforms& draw [[buffer(2)]], const device InstanceData* instances [[buffer(3)]], const device uint* visible [[buffer(4)]],
                          constant float& nearer [[buffer(5)]]) {
  InstanceData inst = instances[visible[iid]];
  EdgeOut out;
  out.position = frame.viewProj * float4(placePoint(inst, float3(points[vid])), 1.0);
  out.position.z *= 1.0 + nearer;  // depth is reversed: larger is nearer
  // How many pixels an LDU looks at the near side of the piece's sphere (as bmr::cull reckons it).
  float distance = length(placePoint(inst, draw.sphere.xyz) - frame.eye.xyz);
  float perLdu = frame.viewport.y / (2.0 * max(distance - draw.sphere.w, 1.0) * frame.lens.x);
  out.fade = smoothstep(frame.lens.y, frame.lens.z, perLdu);
  return out;
}

fragment float4 edgeFragment(EdgeOut in [[stage_in]], constant DrawUniforms& draw [[buffer(2)]]) {
  float a = draw.edge.a * in.fade;
  return float4(draw.edge.rgb * a, a);
}
