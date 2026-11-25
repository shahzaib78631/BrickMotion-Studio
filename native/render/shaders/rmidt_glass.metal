// Rasterized Multi-Interface Dielectric Transport (RMIDT):
// Zero-BVH physical glass refraction, Fresnel reflection, Total Internal Reflection (TIR),
// and Beer-Lambert wall absorption using 3 glass-only interface depth/normal layers +
// screen-space refracted scene tracing.

struct RmidtFrontOut {
  float4 normalDist [[color(0)]];  // xyz: world outward normal, w: camera ray distance (LDU)
  float4 material   [[color(1)]];  // rgb: linear base color, a: 1
};

fragment RmidtFrontOut rmidtFrontFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]],
                                          constant DrawUniforms& draw [[buffer(2)]], depth2d<float> opaqueDepth [[texture(0)]]) {
  uint2 at = uint2(in.position.xy);
  if (in.position.z < opaqueDepth.read(at) - 1e-6) discard_fragment();
  RmidtFrontOut out;
  float3 n = normalize(in.normal);
  float3 base = in.fixedColor.a > 0.5 ? in.fixedColor.rgb : draw.base.rgb;
  float dist = length(in.world - frame.eye.xyz);
  out.normalDist = float4(n, dist);
  out.material = float4(base, 1.0);
  return out;
}

fragment float4 rmidtBackFragment(BrickOut in [[stage_in]], constant FrameUniforms& frame [[buffer(1)]],
                                  depth2d<float> opaqueDepth [[texture(0)]]) {
  uint2 at = uint2(in.position.xy);
  if (in.position.z < opaqueDepth.read(at) - 1e-6) discard_fragment();
  float3 n = normalize(in.normal);
  float dist = length(in.world - frame.eye.xyz);
  return float4(n, dist);
}

float2 rmidtProjectToPixel(float3 v, constant AoUniforms& u) {
  float scale = u.size.w > 0.5 ? 1.0 : -v.z;
  if (scale <= 1e-4) return float2(-1.0);
  float2 ndc = float2(v.x / (scale * u.lens.y), v.y / (scale * u.lens.x));
  return float2((ndc.x * 0.5 + 0.5) * u.shape.w, (0.5 - ndc.y * 0.5) * u.size.x);
}

// Trace a refracted or reflected world-space ray against the already-rendered opaque scene
// depth/color buffers, falling back to the studio floor or environment softboxes.
float3 rmidtTraceScene(float3 originWorld, float3 dirWorld, bool isReflected, constant AoUniforms& u,
                       constant FrameUniforms& frame, depth2d<float> opaqueDepth, texture2d<float> scene,
                       texture2d<float> shares) {
  int2 fullSize = int2(int(u.shape.w), int(u.size.x));
  float3 rel = originWorld - u.eye.xyz;
  float3 oView = float3(dot(rel, u.right.xyz), dot(rel, u.up.xyz), -dot(rel, u.forward.xyz));
  float3 dView = normalize(float3(dot(dirWorld, u.right.xyz), dot(dirWorld, u.up.xyz), -dot(dirWorld, u.forward.xyz)));

  // Perspective/ortho screen-space march along the ray.
  float maxDist = isReflected ? 140.0 : 220.0;
  float prevT = 0.0;
  for (int s = 1; s <= 14; s++) {
    float frac = float(s) / 14.0;
    float tRay = maxDist * (frac * frac * 0.78 + frac * 0.22);
    float stepLen = max(tRay - prevT, 1.0);
    float3 pos = oView + dView * tRay;
    if (pos.z > -u.lens.z) break;
    float2 px = rmidtProjectToPixel(pos, u);
    if (px.x < 1.0 || px.y < 1.0 || px.x >= u.shape.w - 1.0 || px.y >= u.size.x - 1.0) break;
    float4 sceneP = viewPoint(opaqueDepth, int2(px), u);
    if (sceneP.w > 0.0) {
      float dz = sceneP.z - pos.z;
      float thickness = max(3.5, stepLen * 1.45);
      if (dz > 0.02 && dz < thickness) {
        // 4-step binary refinement for crisp refracted silhouettes.
        float lo = prevT, hi = tRay;
        for (int r = 0; r < 4; r++) {
          float mid = 0.5 * (lo + hi);
          float3 mp = oView + dView * mid;
          float2 mpx = rmidtProjectToPixel(mp, u);
          float4 ms = viewPoint(opaqueDepth, int2(clamp(mpx, float2(0.0), float2(u.shape.w - 1.0, u.size.x - 1.0))), u);
          if (ms.w > 0.0 && (ms.z - mp.z) > 0.01) hi = mid;
          else lo = mid;
        }
        float2 hitPx = rmidtProjectToPixel(oView + dView * hi, u);
        int2 hp = clamp(int2(hitPx), int2(0), fullSize - 1);
        float4 hP = viewPoint(opaqueDepth, hp, u);
        float hWorldY = u.eye.y + u.right.y * hP.x + u.up.y * hP.y - u.forward.y * hP.z;
        bool hitFloor = abs(hWorldY - frame.floorPlane.x) < 0.5;
        if (hitFloor) {
          return isReflected ? float3(frame.rig.x) : frame.background.rgb * frame.glass.y;
        }
        float4 c = scene.read(uint2(hp));
        float cov = saturate(c.a);
        if (cov > 0.05) {
          return saturate(c.rgb / cov);
        }
      }
    }
    prevT = tRay;
  }

  // Fallback: check floor plane intersection, else studio environment / background.
  float floorDist = frame.glass.w > 0.5 && dirWorld.y > 1e-5 ? (frame.floorPlane.x - originWorld.y) / dirWorld.y : -1.0;
  if (floorDist > 0.0) {
    return isReflected ? float3(frame.rig.x) : frame.background.rgb * frame.glass.y;
  }
  return isReflected ? glassEnvironment(dirWorld, frame) : frame.background.rgb * frame.glass.y;
}

fragment float4 rmidtResolveFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]],
                                     constant FrameUniforms& frame [[buffer(1)]],
                                     texture2d<float> glassFront [[texture(0)]], texture2d<float> glassMat [[texture(1)]],
                                     texture2d<float> glassBackNear [[texture(2)]], texture2d<float> glassBackFar [[texture(3)]],
                                     depth2d<float> opaqueDepth [[texture(4)]], texture2d<float> scene [[texture(5)]],
                                     texture2d<float> shares [[texture(6)]]) {
  uint2 at = uint2(in.position.xy);
  float4 front = glassFront.read(at);
  if (front.w <= 0.0) return float4(0.0);

  float4 mat = glassMat.read(at);
  float4 backNear = glassBackNear.read(at);
  float4 backFar = glassBackFar.read(at);

  // Reconstruct world-space camera ray through this pixel.
  float2 ndc = float2((float(at.x) + 0.5) / u.shape.w * 2.0 - 1.0, 1.0 - (float(at.y) + 0.5) / u.size.x * 2.0);
  float3 rd;
  float3 rayOrigin;
  if (u.size.w > 0.5) {
    rd = normalize(u.forward.xyz);
    rayOrigin = u.eye.xyz + u.right.xyz * (ndc.x * u.lens.y) + u.up.xyz * (ndc.y * u.lens.x);
  } else {
    rd = normalize(u.forward.xyz + u.right.xyz * (ndc.x * u.lens.y) + u.up.xyz * (ndc.y * u.lens.x));
    rayOrigin = u.eye.xyz;
  }

  float3 p0 = rayOrigin + rd * front.w;
  float3 n0 = normalize(front.xyz);
  if (dot(n0, -rd) < 0.0) n0 = -n0;

  float ior = frame.glass.z;  // kGlassIor (~1.45)
  // Exact Beer-Lambert extinction per LDU matching glass_transport.metal.
  float3 absorption = frame.glass.x * saturate(1.0 - mat.rgb) / 6.0;

  // --- Interface 1: Air -> Plastic ---
  GlassInterface b1 = glassInterface(rd, n0, 1.0 / ior);
  float3 reflDir1 = normalize(reflect(rd, n0));
  float3 reflCol1 = rmidtTraceScene(p0 + n0 * 0.15, reflDir1, true, u, frame, opaqueDepth, scene, shares);
  float3 result = reflCol1 * b1.fresnel;

  if (!b1.transmits) return float4(saturate(result), 1.0);

  // Physical wall thickness between front entry and nearest inner back wall.
  float dWall1 = (backNear.w > front.w + 0.05) ? clamp(backNear.w - front.w, 0.6, 36.0) : 3.2;
  float3 d1 = b1.transmitted;
  // Refracted ray travels longer at oblique angles inside the wall.
  float cosIn = max(abs(dot(d1, -n0)), 0.35);
  float seg1 = min(dWall1 / cosIn, 42.0);
  float3 w1 = float3(1.0 - b1.fresnel) * exp(-absorption * seg1);
  float3 p1 = p0 + d1 * dWall1;

  // --- Interface 2: Plastic -> Air (inner wall exit + Total Internal Reflection) ---
  float3 n1 = (backNear.w > 0.0) ? -normalize(backNear.xyz) : -n0;
  if (dot(n1, -d1) < 0.0) n1 = -n1;
  GlassInterface b2 = glassInterface(d1, n1, ior);

  // Internal reflection / TIR branch: signature bright/crisp internal glass rims & bevels.
  if (b2.fresnel > 0.01) {
    float3 tirDir = normalize(reflect(d1, n1));
    // Internally reflected ray travels back across the wall and exits into the scene/studio.
    float3 tirAtten = exp(-absorption * seg1 * 0.9);
    float3 tirCol = rmidtTraceScene(p1 + tirDir * 0.2, tirDir, true, u, frame, opaqueDepth, scene, shares);
    result += w1 * b2.fresnel * tirAtten * tirCol;
  }

  // Transmitted branch exiting wall 1.
  if (b2.transmits) {
    float3 w2 = w1 * (1.0 - b2.fresnel);
    float3 dExit = b2.transmitted;
    float3 pExit = p1 + dExit * 0.25;

    // --- Optional Interfaces 3 & 4: Far wall across hollow LEGO cavity ---
    if (backFar.w > backNear.w + 1.2) {
      float cavitySpan = backFar.w - backNear.w;
      // Approximate second shell wall thickness and exit refraction through far back wall.
      float dWall2 = clamp(min(dWall1, cavitySpan * 0.35), 1.2, 18.0);
      float3 nFar = normalize(backFar.xyz);
      if (dot(nFar, dExit) < 0.0) nFar = -nFar;
      // Thin-shell attenuation + slight normal-guided refraction at far wall.
      GlassInterface b3 = glassInterface(dExit, -nFar, 1.0 / ior);
      float3 w3 = w2 * (1.0 - b3.fresnel) * exp(-absorption * dWall2);
      // Add subtle internal reflection from the far inner wall (adds depth inside hollow bricks).
      if (b3.fresnel > 0.01) {
        float3 farRefl = normalize(reflect(dExit, -nFar));
        float3 farCol = rmidtTraceScene(rayOrigin + rd * backFar.w + farRefl * 0.2, farRefl, true, u, frame, opaqueDepth, scene, shares);
        result += w2 * b3.fresnel * farCol;
      }
      w2 = w3;
      if (b3.transmits) {
        GlassInterface b4 = glassInterface(b3.transmitted, -nFar, ior);
        if (b4.transmits) dExit = b4.transmitted;
      }
      pExit = rayOrigin + rd * backFar.w + dExit * 0.25;
    }

    float3 refractedScene = rmidtTraceScene(pExit, dExit, false, u, frame, opaqueDepth, scene, shares);
    result += w2 * refractedScene;
  }

  return float4(saturate(result), 1.0);
}
