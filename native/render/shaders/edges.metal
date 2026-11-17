// Outline lines: each mesh's edges, drawn for every instance shown at full detail, a little
// nearer the eye than the faces they lie on, in the material's edge colour.

vertex float4 edgeVertex(uint vid [[vertex_id]], uint iid [[instance_id]], const device packed_float3* points [[buffer(0)]], constant FrameUniforms& frame [[buffer(1)]],
                         const device InstanceData* instances [[buffer(3)]], const device uint* visible [[buffer(4)]], constant float& nearer [[buffer(5)]]) {
  InstanceData inst = instances[visible[iid]];
  float4 p = frame.viewProj * float4(placePoint(inst, float3(points[vid])), 1.0);
  p.z *= 1.0 + nearer;  // depth is reversed: larger is nearer
  return p;
}

fragment float4 edgeFragment(constant DrawUniforms& draw [[buffer(2)]]) { return float4(draw.edge.rgb * draw.edge.a, draw.edge.a); }
