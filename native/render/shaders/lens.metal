// Depth of field: the web's lens blur (src/render/depthOfField.ts), applied to the finished
// picture so the floor, the backdrop and the bricks blur together.
//
// A single-pass "scatter as gather" disc (after Dennis Gustafsson): each pixel gathers samples
// along a golden-angle spiral, and a sample counts as far as its own blur reaches. Sharp things
// in front stay sharp; blurred things in front spill over what is behind them, as a real lens
// does. The picture is an sRGB texture, so it is read, blurred and written in linear light.

// Must match LensUniforms in src/metal/frame.mm.
struct LensUniforms {
  float2 texel;     // 1 / width, 1 / height
  float focus;      // the distance in focus, LDU from the eye along the view
  float maxR;       // the largest blur radius, pixels
  float radScale;   // the spiral's step
  float depthA;     // perspective: distance = depthB / (depth + depthA)
  float depthB;
  float ortho;      // 1: parallel projection, distance = depthFar - depth * (depthFar - depthNear)
  float depthNear;
  float depthFar;
};

// 1 / distance at a pixel: 0 where nothing was drawn (the backdrop, infinitely far).
static float inverseDistance(depth2d<float> depth, float2 uv, constant LensUniforms& lens) {
  uint2 size = uint2(depth.get_width(), depth.get_height());
  uint2 at = min(uint2(max(uv, 0.0) * float2(size)), size - 1);
  float d = depth.read(at);
  if (d <= 0.0) return 0.0;  // reversed depth: cleared to 0, the far plane
  if (lens.ortho > 0.5) return 1.0 / max(lens.depthFar - d * (lens.depthFar - lens.depthNear), 1e-3);
  return (d + lens.depthA) / lens.depthB;
}

// Thin-lens shape (depthOfField.ts blurRadius): zero at the focus, growing with |1 - focus / distance|.
static float circleOfConfusion(float inv, constant LensUniforms& lens) {
  return min(lens.maxR, abs(1.0 - lens.focus * inv) * lens.maxR * 3.0);
}

fragment float4 lensFragment(ScreenOut in [[stage_in]], constant LensUniforms& lens [[buffer(0)]],
                             texture2d<float> picture [[texture(0)]], depth2d<float> depth [[texture(1)]],
                             sampler smooth [[sampler(0)]]) {
  const float golden = 2.39996323;
  float2 uv = in.uv;
  float cInv = inverseDistance(depth, uv, lens);
  float cSize = circleOfConfusion(cInv, lens);
  float4 centre = picture.sample(smooth, uv);
  float3 col = centre.rgb;
  float tot = 1.0;
  float radius = lens.radScale;
  float ang = 0.0;
  for (int i = 0; i < 2000 && radius < lens.maxR; i++) {
    float2 tc = uv + float2(cos(ang), sin(ang)) * lens.texel * radius;
    float sInv = inverseDistance(depth, tc, lens);
    float sSize = circleOfConfusion(sInv, lens);
    // a sample behind this pixel cannot blur over it more than this pixel blurs itself
    if (sInv < cInv) sSize = clamp(sSize, 0.0, cSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sSize);
    col += mix(col / tot, picture.sample(smooth, tc).rgb, m);
    tot += 1.0;
    ang += golden;
    radius += lens.radScale / radius;
  }
  return float4(col / tot, centre.a);
}
