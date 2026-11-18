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
  float4 shares [[color(3)]];  // g: 1, open floor (glass in front clears it); a: 1, floor
};

// A shadow catcher, as EyeSight's ground is: the background, times the share of a white
// floor's light that reaches it past the model (floor_light.metal, worked out in the half-size
// pass, fading out toward the floor's rim there).
fragment FloorColor floorFragment(FloorOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]]) {
  // LDraw is +Y down. The shadow catcher must not occlude the model from below.
  if (frame.eye.y >= frame.floorPlane.x) discard_fragment();
  FloorColor out;
  out.color = float4(0);
  out.shares = float4(0, 1, 0, 1);
  return out;
}
