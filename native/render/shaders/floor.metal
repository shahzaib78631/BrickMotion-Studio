// The floor: a square under the model in the background's colour, so all it shows is what
// falls on it. It writes black with the darkness as coverage; the last pass turns that into
// the background, darkened.

struct FloorOut {
  float4 position [[position]];
  float3 world;
};

vertex FloorOut floorVertex(uint id [[vertex_id]], constant FrameUniforms& frame [[buffer(1)]]) {
  const float2 corners[6] = {float2(-1, -1), float2(1, -1), float2(1, 1), float2(-1, -1), float2(1, 1), float2(-1, 1)};
  float2 c = corners[id] * frame.floorPlane.y;
  FloorOut out;
  out.world = float3(frame.floorCentre.x + c.x, frame.floorPlane.x, frame.floorCentre.y + c.y);
  out.position = frame.viewProj * float4(out.world, 1.0);
  return out;
}

struct FloorColor {
  float4 color [[color(0)]];
  float2 ambient [[color(3)]];  // g: this is floor
};

fragment FloorColor floorFragment(FloorOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]], depth2d<float> shadowMap [[texture(2)]], sampler shadowSampler [[sampler(1)]]) {
  float lit = frame.switches.x > 0.5 ? keyShadow(in.world, float3(0, -1, 0), frame, shadowMap, shadowSampler) : 1.0;
  float reach = frame.floorPlane.y;
  float fade = 1.0 - smoothstep(0.5 * reach, reach, length(in.world.xz - frame.floorCentre.xy));
  float dark = frame.floorCentre.z * (1.0 - lit) * fade;
  FloorColor out;
  out.color = float4(0, 0, 0, dark);
  out.ambient = float2(0, 1);
  return out;
}
