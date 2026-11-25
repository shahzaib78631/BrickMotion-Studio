// Screen-Space Path-Traced Lighting (SSPT): colored indirect diffuse bounce (SSGI),
// glossy clearcoat screen-space reflections (SSR), and micro-contact shadows.
// Runs at half resolution after the main pass and AO pass with zero hardware RT overhead.

struct SsptOut {
  float4 gi  [[color(0)]];  // rgb: colored indirect bounce irradiance, a: micro-contact shadow (1 lit, 0 occluded)
  float4 ssr [[color(1)]];  // rgb: glossy reflection radiance, a: reflection confidence (0..1)
};

// Reconstruct visible linear radiance at a full-resolution pixel, including transparent glass
// so opaque bricks reflect and receive colored bounce from transparent canopies/bricks.
float3 ssptRadiance(int2 at, texture2d<float> scene, texture2d<float> accum, texture2d<float> reveal,
                    texture2d<float> glassResolved, constant FrameUniforms& frame, bool hasBlend) {
  int2 size = int2(scene.get_width(), scene.get_height());
  uint2 p = uint2(clamp(at, int2(0), size - 1));
  float4 gr = glassResolved.read(p);
  if (gr.a > 0.5) return gr.rgb;
  float4 c = scene.read(p);
  float cov = saturate(c.a);
  float3 col = cov > 1e-4 ? saturate(c.rgb / cov) * cov : float3(0.0);
  if (cov < 0.99) {
    col += frame.background.rgb * (1.0 - cov);
  }
  if (hasBlend) {
    float4 sum = accum.read(p);
    float4 dep = reveal.read(p);
    if (sum.a > 1e-6 || dep.a > 1e-6) {
      float3 mean = sum.a > 1e-6 ? sum.rgb / sum.a : float3(0.0);
      col = col * exp(-dep.rgb - dep.a) + mean * (1.0 - exp(-dep.a));
    }
  }
  return col;
}

// Project a view-space point to full-resolution pixel coordinates. Returns (-1,-1) if behind camera.
float2 projectToPixel(float3 v, constant AoUniforms& u) {
  float scale = u.size.w > 0.5 ? 1.0 : -v.z;
  if (scale <= 1e-4) return float2(-1.0);
  float2 ndc = float2(v.x / (scale * u.lens.y), v.y / (scale * u.lens.x));
  return float2((ndc.x * 0.5 + 0.5) * u.shape.w, (0.5 - ndc.y * 0.5) * u.size.x);
}

fragment SsptOut ssptFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]],
                              constant FrameUniforms& frame [[buffer(1)]],
                              depth2d<float> depth [[texture(0)]], texture2d<float> scene [[texture(1)]],
                              texture2d<float> accum [[texture(2)]], texture2d<float> reveal [[texture(3)]],
                              texture2d<float> shares [[texture(4)]], texture2d<float> glassResolved [[texture(5)]],
                              texture2d<float> glassFront [[texture(6)]]) {
  SsptOut out;
  out.gi = float4(0.0, 0.0, 0.0, 1.0);
  out.ssr = float4(0.0, 0.0, 0.0, 0.0);

  int2 cell = int2(in.position.xy);
  int2 at = cell * int(u.grid.x);
  int2 fullSize = int2(int(u.shape.w), int(u.size.x));
  float4 p = viewPoint(depth, at, u);
  if (p.w == 0.0) return out;

  // Depth-edge-preserving view-space normal reconstruction (matching ao.metal).
  float4 l = viewPoint(depth, at - int2(1, 0), u), r = viewPoint(depth, at + int2(1, 0), u);
  float4 t = viewPoint(depth, at - int2(0, 1), u), b = viewPoint(depth, at + int2(0, 1), u);
  float3 dx = (r.w > 0 && (l.w == 0 || abs(r.z - p.z) < abs(l.z - p.z))) ? r.xyz - p.xyz : p.xyz - l.xyz;
  float3 dy = (b.w > 0 && (t.w == 0 || abs(b.z - p.z) < abs(t.z - p.z))) ? p.xyz - b.xyz : t.xyz - p.xyz;
  float3 n = normalize(cross(dx, dy));
  if (dot(n, -p.xyz) < 0.0) n = -n;

  float3 world = u.eye.xyz + u.right.xyz * p.x + u.up.xyz * p.y - u.forward.xyz * p.z;
  float4 share = shares.read(uint2(at));
  bool onFloor = share.a > 0.0 && abs(world.y - frame.floorPlane.x) < 0.025;
  bool hasBlend = frame.switches.w > 0.5;

  const float pattern[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
  float jitter = (pattern[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;

  // 1. Colored Indirect Diffuse Bounce (SSGI) — 8 horizon-tracked directions x 4 steps.
  float giRadius = u.shape.x * (onFloor ? 1.8 : 1.35);
  float scale = u.size.w > 0.5 ? 1.0 : -p.z;
  float reach = min(giRadius / (scale * u.lens.x) * u.size.x * 0.5, 140.0);
  if (reach >= 1.5) {
    float3 bounceSum = float3(0.0);
    for (int i = 0; i < 8; i++) {
      float angle = (float(i) + jitter) * (6.2831853 / 8.0);
      float2 dir = float2(cos(angle), sin(angle));
      float maxHorizon = 0.05;
      for (int s = 0; s < 4; s++) {
        float frac = (float(s) + fract(jitter * 5.0 + 0.25)) / 4.0;
        float2 stepPx = dir * reach * (frac * frac * 0.65 + frac * 0.35);
        int2 sp = at + int2(round(stepPx));
        if (sp.x < 0 || sp.y < 0 || sp.x >= fullSize.x || sp.y >= fullSize.y) continue;
        float4 q = viewPoint(depth, sp, u);
        if (q.w == 0.0) continue;
        // Exclude white floor from acting as an indirect emitter onto bricks or other floor pixels.
        float qWorldY = u.eye.y + u.right.y * q.x + u.up.y * q.y - u.forward.y * q.z;
        if (abs(qWorldY - frame.floorPlane.x) < 0.5) continue;
        float3 v = q.xyz - p.xyz;
        float dist = length(v);
        if (dist < 0.5 || dist > giRadius) continue;
        float horizon = dot(n, v) / dist;
        if (horizon <= maxHorizon) continue;
        float gain = horizon - maxHorizon;
        maxHorizon = horizon;
        float fade = 1.0 - (dist / giRadius);
        fade *= fade;
        float3 rad = ssptRadiance(sp, scene, accum, reveal, glassResolved, frame, hasBlend);
        // Emphasize chromatic bounce relative to neutral white studio background so colored bricks bleed naturally.
        bounceSum += rad * (gain * fade);
      }
    }
    out.gi.rgb = bounceSum / 8.0;
  }

  // 2. Micro-Contact Shadows along key light (bricks only; floor has height-map + PCSS).
  if (!onFloor && frame.switches.x > 0.5) {
    float3 Lworld = frame.lights[0].xyz;
    float3 Lview = normalize(float3(dot(Lworld, u.right.xyz), dot(Lworld, u.up.xyz), -dot(Lworld, u.forward.xyz)));
    if (dot(n, Lview) > 0.05) {
      float contact = 1.0;
      float maxRay = 7.5;  // LDU: catches stud rims, plate seams, and undercarriage crevices
      for (int s = 1; s <= 6; s++) {
        float tRay = maxRay * (float(s) - 0.5 + 0.5 * jitter) / 6.0;
        float3 samplePos = p.xyz + n * 0.28 + Lview * tRay;
        float2 px = projectToPixel(samplePos, u);
        if (px.x < 1.0 || px.y < 1.0 || px.x >= u.shape.w - 1.0 || px.y >= u.size.x - 1.0) break;
        float4 hitP = viewPoint(depth, int2(px), u);
        if (hitP.w == 0.0) continue;
        // View space: -z is distance from camera, so hitP.z > samplePos.z means hitP is closer to camera.
        float dz = hitP.z - samplePos.z;
        if (dz > 0.18 && dz < 3.2) {
          float atten = 1.0 - (tRay / maxRay);
          contact = min(contact, 1.0 - 0.55 * atten);
        }
      }
      out.gi.a = contact;
    }
  }

  // 3. Glossy Clearcoat Screen-Space Reflections (SSR) — adaptive view-space ray march + binary refinement.
  // Runs on opaque bricks (and softly on the floor near the model).
  float3 viewDir = normalize(p.xyz);
  float nv = saturate(dot(n, -viewDir));
  float3 reflDir = reflect(viewDir, n);
  // Skip rays pointing back toward the camera (off-screen) or grazing almost parallel to the surface.
  if (reflDir.z < 0.75 && nv > 0.02) {
    float maxDist = onFloor ? 55.0 : 90.0;
    float3 rayOrigin = p.xyz + n * (onFloor ? 0.45 : 0.35);
    float prevT = 0.0;
    bool hit = false;
    float hitT = 0.0;
    float2 hitPx = float2(0.0);

    for (int s = 1; s <= 16; s++) {
      float uStep = (float(s) - 0.5 + 0.5 * jitter) / 16.0;
      float tRay = maxDist * (uStep * uStep * 0.8 + uStep * 0.2);
      float stepLen = max(tRay - prevT, 1.0);
      float3 pos = rayOrigin + reflDir * tRay;
      if (pos.z > -u.lens.z) break;
      float2 px = projectToPixel(pos, u);
      if (px.x < 1.0 || px.y < 1.0 || px.x >= u.shape.w - 1.0 || px.y >= u.size.x - 1.0) break;
      float4 sceneP = viewPoint(depth, int2(px), u);
      if (sceneP.w > 0.0) {
        float dz = sceneP.z - pos.z;
        float thickness = clamp(stepLen * 0.75, 0.8, 3.0);
        if (dz > 0.05 && dz < thickness) {
          // 4-step binary refinement for crisp glossy reflection silhouettes.
          float lo = prevT, hi = tRay;
          for (int rStep = 0; rStep < 4; rStep++) {
            float mid = 0.5 * (lo + hi);
            float3 mp = rayOrigin + reflDir * mid;
            float2 mpx = projectToPixel(mp, u);
            float4 ms = viewPoint(depth, int2(clamp(mpx, float2(0.0), float2(u.shape.w - 1.0, u.size.x - 1.0))), u);
            if (ms.w > 0.0 && (ms.z - mp.z) > 0.02) hi = mid;
            else lo = mid;
          }
          hitT = hi;
          hitPx = projectToPixel(rayOrigin + reflDir * hitT, u);
          hit = true;
          break;
        }
      }
      // Depth-tested RMIDT glass hit: compare ray distance from camera against exact glassFront.w
      // so rays passing in front of or behind a window never ghost onto adjacent opaque walls.
      if (!onFloor) {
        float glassDist = glassFront.read(uint2(px)).w;
        if (glassDist > 0.0) {
          float posDist = length(pos);
          float dzGlass = posDist - glassDist;
          float gThick = clamp(stepLen * 0.85, 1.0, 4.0);
          if (dzGlass > 0.05 && dzGlass < gThick) {
            hitT = tRay;
            hitPx = px;
            hit = true;
            break;
          }
        }
      }
      prevT = tRay;
    }

    if (hit) {
      int2 hp = clamp(int2(hitPx), int2(0), fullSize - 1);
      float4 hScene = viewPoint(depth, hp, u);
      float hWorldY = u.eye.y + u.right.y * hScene.x + u.up.y * hScene.y - u.forward.y * hScene.z;
      bool hitGlass = glassFront.read(uint2(hp)).w > 0.0 && glassResolved.read(uint2(hp)).a > 0.5;
      bool hitFloor = !hitGlass && abs(hWorldY - frame.floorPlane.x) < 0.5;
      if (!hitFloor) {
        float3 reflCol = ssptRadiance(hp, scene, accum, reveal, glassResolved, frame, hasBlend);
        float2 edgeUv = hitPx / float2(u.shape.w, u.size.x);
        float2 edgeFade = smoothstep(float2(0.0), float2(0.08), edgeUv) * smoothstep(float2(1.0), float2(0.92), edgeUv);
        float distFade = 1.0 - smoothstep(0.55 * maxDist, maxDist, hitT);
        // Physical ABS clearcoat Schlick Fresnel (F0 = 0.04): subtle at normal incidence, stronger at grazing angles.
        float fresnel = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
        float spec = onFloor ? saturate(fresnel * 0.8) : saturate(fresnel * 1.6);
        float weight = edgeFade.x * edgeFade.y * distFade * spec;
        out.ssr = float4(reflCol, weight);
      }
    }
  }

  return out;
}

// Depth- and floor-aware 5x5 bilateral filter for SSGI + SSR.
fragment SsptOut ssptBlurFragment(ScreenOut in [[stage_in]], constant AoUniforms& u [[buffer(0)]],
                                  texture2d<float> giRaw [[texture(0)]], texture2d<float> ssrRaw [[texture(1)]],
                                  depth2d<float> depth [[texture(2)]], texture2d<float> shares [[texture(3)]]) {
  int2 cell = int2(in.position.xy);
  int2 halfSize = int2(int(u.size.y), int(u.size.z));
  int2 fullSize = int2(int(u.shape.w), int(u.size.x));
  int2 fullAt = clamp(cell * int(u.grid.x), int2(0), fullSize - 1);
  float centre = depth.read(uint2(fullAt));
  SsptOut out;
  out.gi = giRaw.read(uint2(cell));
  out.ssr = ssrRaw.read(uint2(cell));
  if (centre <= 0.0) return out;

  float z = viewDepth(centre, u);
  bool onFloor = shares.read(uint2(fullAt)).a > 0.5;

  float4 giSum = float4(0.0);
  float4 ssrSum = float4(0.0);
  float giW = 0.0, ssrW = 0.0;

  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      int2 q = clamp(cell + int2(x, y), int2(0), halfSize - 1);
      int2 qFull = clamp(q * int(u.grid.x), int2(0), fullSize - 1);
      float d = depth.read(uint2(qFull));
      if (d <= 0.0) continue;
      bool qFloor = shares.read(uint2(qFull)).a > 0.5;
      if (qFloor != onFloor) continue;
      float spatial = exp(-float(x * x + y * y) / 4.5);
      float depthW = exp(-abs(viewDepth(d, u) - z) / (0.025 * z));
      float w = spatial * depthW;
      giSum += giRaw.read(uint2(q)) * w;
      giW += w;
      // Tighter spatial kernel for glossy SSR so reflections stay crisp.
      if (abs(x) <= 1 && abs(y) <= 1) {
        float4 s = ssrRaw.read(uint2(q));
        float sw = spatial * depthW;
        ssrSum += s * sw;
        ssrW += sw;
      }
    }
  }
  if (giW > 1e-4) out.gi = giSum / giW;
  if (ssrW > 1e-4) out.ssr = ssrSum / ssrW;
  return out;
}
