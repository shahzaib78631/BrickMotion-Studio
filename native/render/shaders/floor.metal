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
  if (frame.grid.x > 0.0) {
    float2 q = (in.world.xz + frame.grid.yz) / frame.grid.x;
    float2 width = max(fwidth(q), float2(0.0001));
    float2 fraction = abs(fract(q - 0.5) - 0.5);
    float2 major = abs(fract(q / 5.0 - 0.5) - 0.5) * 5.0;
    float minorLine = 1.0 - min(min(fraction.x / width.x, fraction.y / width.y), 1.0);
    float majorLine = 1.0 - min(min(major.x / width.x, major.y / width.y), 1.0);
    float a = max(0.09 * minorLine * (1.0 - smoothstep(0.2, 0.8, max(width.x, width.y))),
                  0.17 * majorLine * (1.0 - smoothstep(0.5, 1.4, max(width.x, width.y))));
    a *= floorFade(in.world, frame);
    float value = dot(frame.background.rgb, float3(0.2126, 0.7152, 0.0722)) > 0.35 ? 0.04 : 0.7;
    out.color = float4(float3(value * a), a);
  }
  return out;
}
