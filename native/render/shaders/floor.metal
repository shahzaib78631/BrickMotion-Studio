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
  float4 shares [[color(3)]];  // g: the share of a white floor's light occlusion takes, a: the share the key's shadow takes
};

// A shadow catcher, as EyeSight's ground is: the background, darkened in the last pass by
// what occlusion takes of the light a white floor would have from the world and the fills, and
// what the key light's shadow takes of the key's. Both fade out toward the floor's rim.
fragment FloorColor floorFragment(FloorOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]]) {
  const float pi = 3.14159265;
  float key = frame.lights[0].w * diskLight(-frame.lights[0].y, frame.rig.y) / pi, rest = frame.rig.x;
  for (int i = 1; i < 4; i++) rest += frame.lights[i].w * diskLight(-frame.lights[i].y, frame.rig.y) / pi;
  float reach = frame.floorPlane.y;
  float fade = 1.0 - smoothstep(0.15 * reach, 0.35 * reach, length(in.world.xz - frame.floorCentre.xy));
  FloorColor out;
  out.color = float4(0);
  out.shares = float4(0, rest / (key + rest) * fade, 0, key / (key + rest) * fade);
  return out;
}
