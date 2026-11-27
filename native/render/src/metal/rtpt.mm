// Real-Time Path Tracing (RTPT): Adaptive Control-Variate Direct Studio Lighting +
// SHaRC World-Space Radiance Cache + Separate Dual-Lobe Bounded-VNDF Clearcoat/Glossy RT +
// Full-Res Contact-Sharp Floor Shadow Catcher + Deterministic-Fresnel 16-Bounce Glass RT +
// Demodulated SVGF 5-Tap A-Trous + SRAM Halton TAA / Unbiased Progressive Convergence.
#import "metal/impl.h"
#import "metal/path_impl.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <vector>
#include "bmr/cull.h"
#include "bmr/material.h"
#include "bmr/tolerances.h"

namespace bmr {
namespace {

constexpr uint32_t kRtptSharcCap = 262144u;

// Must match RtptUniforms in shaders/rtpt.metal field for field.
struct RtptUniformsGpu {
  simd_float4x4 viewProjJittered;
  simd_float4x4 viewProjUnjittered;
  simd_float4x4 prevViewProj;
  simd_float4 eye;
  simd_float4 right;
  simd_float4 up;
  simd_float4 forward;
  simd_float4 lights[4];
  simd_float4 rig;
  simd_float4 background;
  simd_float4 floorPlane;
  simd_float4 floorCentre;
  simd_float4 sceneMin;
  simd_float4 sceneMax;
  simd_float4 glass;
  simd_float4 jitter;
  simd_float4 selection;
  simd_uint4 size;
  simd_uint4 flags;
  simd_uint4 params;
};

struct RtptPrevPoseGpu {
  simd_float4 r0, r1, r2;
};

struct RtptSharcAccumGpu {
  uint32_t key, radR, radG, radB, count, pad0, pad1, pad2;
};

struct RtptSharcResolvedGpu {
  simd_float4 radSamples;
  simd_uint4 keyAge;
};

float halton(uint32_t index, uint32_t base) {
  float f = 1.0f, r = 0.0f;
  uint32_t i = index;
  while (i > 0u) {
    f /= static_cast<float>(base);
    r += f * static_cast<float>(i % base);
    i /= base;
  }
  return r;
}

bool sameRtptCamera(const Camera& a, const Camera& b) {
  auto eq = [](double x, double y) { return std::abs(x - y) <= 1e-6; };
  auto eq3 = [&](bm::Vec3 u, bm::Vec3 v) { return eq(u.x, v.x) && eq(u.y, v.y) && eq(u.z, v.z); };
  return eq3(a.eye, b.eye) && eq3(a.target, b.target) && eq3(a.up, b.up) && eq(a.fovY, b.fovY) &&
         eq(a.aspect, b.aspect) && eq(a.orthoHalfHeight, b.orthoHalfHeight);
}

void rtptCameraBasis(const Camera& c, bm::Vec3& right, bm::Vec3& up, bm::Vec3& forward) {
  forward = c.target - c.eye;
  forward = bm::length(forward) > 1e-12 ? bm::normalized(forward) : bm::Vec3{0, 0, -1};
  right = bm::cross(forward, c.up);
  if (!(bm::length(right) > 1e-9)) right = bm::cross(forward, std::abs(forward.x) < 0.9 ? bm::Vec3{1, 0, 0} : bm::Vec3{0, 0, 1});
  right = bm::normalized(right);
  up = bm::cross(right, forward);
}

simd_float4 rtptF4(bm::Vec3 v, double w) {
  return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), static_cast<float>(w));
}

}  // namespace

FrameStats Renderer::Impl::drawRealtimePathTraced(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable) {
  FrameStats stats;
  const auto started = std::chrono::steady_clock::now();
  id<MTLTexture> target = drawable ? drawable.texture : final;
  if (!target || width < 1 || height < 1 || !pipelines.rtptGbufOpaque || !pipelines.rtptGbufGlass ||
      !pipelines.rtptGbufFloor || !pipelines.rtptPresent || !pipelines.rtptSharcResolve ||
      !pipelines.rtptDirectPass || !pipelines.rtptTraceFloor || !pipelines.rtptTraceOpaque ||
      !pipelines.rtptTraceGlass || !pipelines.rtptSvgfTemporal || !pipelines.rtptSvgfAtrous ||
      !pipelines.rtptResolveTaa) {
    return stats;
  }

  if (!ptInitTried) {
    ptInitTried = true;
    std::string err;
    ptScene = PathScene::create(&err);
  }
  if (!ptScene) return stats;

  const bool sceneChanged = (ptSceneRevision != lastChange);
  if (sceneChanged) {
    ptScene->prepare(scene, *meshes);
    ptSceneRevision = lastChange;
  }

  id<MTLDevice> dev = device->device;

  // Allocate/resize GPU targets lazily.
  if (rtptW != width || rtptH != height || !rtptDepth || !rtptSharcAccum) {
    auto mkTex = [&](MTLPixelFormat fmt, MTLTextureUsage usage) {
      MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:fmt
                                                                                   width:static_cast<NSUInteger>(width)
                                                                                  height:static_cast<NSUInteger>(height)
                                                                               mipmapped:NO];
      d.usage = usage;
      d.storageMode = MTLStorageModePrivate;
      return [dev newTextureWithDescriptor:d];
    };
    const MTLTextureUsage gbufUsage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    const MTLTextureUsage rwUsage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
    rtptDepth = mkTex(MTLPixelFormatDepth32Float, MTLTextureUsageRenderTarget);
    for (int i = 0; i < 2; i++) {
      rtptPosId[i] = mkTex(MTLPixelFormatRGBA32Float, gbufUsage);
      rtptNorm[i] = mkTex(MTLPixelFormatRGBA16Float, gbufUsage);
      rtptDiffHist[i] = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
      rtptSpecHist[i] = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
      rtptMoments[i] = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
      rtptHLen[i] = mkTex(MTLPixelFormatRG16Float, rwUsage);
      rtptTaa[i] = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    }
    rtptMat = mkTex(MTLPixelFormatRGBA16Float, gbufUsage);
    rtptMotion = mkTex(MTLPixelFormatRGBA16Float, gbufUsage);
    rtptDi = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptDiffRaw = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptSpecRaw = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptDiffPing = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptSpecPing = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptDiffPong = mkTex(MTLPixelFormatRGBA16Float, rwUsage);
    rtptSpecPong = mkTex(MTLPixelFormatRGBA16Float, rwUsage);

    if (!rtptSharcAccum) {
      rtptSharcAccum = [dev newBufferWithLength:kRtptSharcCap * sizeof(RtptSharcAccumGpu) options:MTLResourceStorageModePrivate];
      rtptSharcResolved = [dev newBufferWithLength:kRtptSharcCap * sizeof(RtptSharcResolvedGpu) options:MTLResourceStorageModePrivate];
      id<MTLCommandBuffer> initCmd = [device->queue commandBuffer];
      id<MTLBlitCommandEncoder> blit = [initCmd blitCommandEncoder];
      [blit fillBuffer:rtptSharcAccum range:NSMakeRange(0, rtptSharcAccum.length) value:0];
      [blit fillBuffer:rtptSharcResolved range:NSMakeRange(0, rtptSharcResolved.length) value:0];
      [blit endEncoding];
      [initCmd commit];
      [initCmd waitUntilCompleted];
    }
    rtptW = width;
    rtptH = height;
    rtptHasHistory = false;
    rtptStillFrames = 0;
  }

  // Cull visible instances (reusing standard frustum + LOD culling so picking stays exact).
  cullInto(inView, scene, parts, camera, height, options.forceDetail, options.cull, false);
  auto& list = nextList;
  auto& seen = nextSeen;
  list.clear();
  seen.clear();
  auto add = [&](std::vector<Batch>& into, uint32_t g, Detail d, const std::vector<uint32_t>& instances, bool top = false) {
    const Group& group = scene.groups[g];
    for (int mirrored = 0; mirrored < 2; mirrored++) {
      const uint32_t first = static_cast<uint32_t>(list.size());
      for (uint32_t i : instances)
        if (((group.instances[i].flags & kMirrored) != 0) == (mirrored != 0)) list.push_back(i);
      if (list.size() > first) into.push_back({g, d, mirrored != 0, first, static_cast<uint32_t>(list.size()) - first, top});
    }
  };
  for (uint32_t g = 0; g < scene.groups.size(); g++) {
    for (int d = 0; d < 2; d++) {
      add(seen, g, static_cast<Detail>(d), inView[g].above[d], true);
      add(seen, g, static_cast<Detail>(d), inView[g].below[d]);
    }
    add(seen, g, Detail::Box, inView[g].byDetail[2]);
    stats.culled += inView[g].culled;
  }

  bool hasPlaceholders = false;
  for (const Group& g : scene.groups) {
    if (g.placeholder && !g.instances.empty()) {
      hasPlaceholders = true;
      break;
    }
  }
  bool glassInView = false;
  for (const Batch& batch : seen) {
    const Group& group = scene.groups[batch.group];
    if (group.placeholder || (group.material.transparent() && !options.clay)) {
      glassInView = true;
      break;
    }
  }

  // Selected pieces for the editor's blue outline.
  std::vector<Batch> selected;
  for (const Batch& batch : seen) {
    const Group& group = scene.groups[batch.group];
    const uint32_t first = static_cast<uint32_t>(list.size());
    for (uint32_t k = 0; k < batch.count; k++) {
      const uint32_t i = list[batch.first + k];
      if (group.instances[i].flags & kSelected) list.push_back(i);
    }
    if (list.size() > first) selected.push_back({batch.group, batch.detail, batch.mirrored, first, static_cast<uint32_t>(list.size()) - first, batch.top});
  }

  // Detect look/camera/scene stability for seamless unbiased progressive convergence.
  const bool lookChanged = (rtptLastFloor != options.floor) || (rtptLastLightsFollow != options.lightsFollowCamera) ||
                           (rtptLastClay != options.clay) || (rtptLastBg[0] != options.background[0]) ||
                           (rtptLastBg[1] != options.background[1]) || (rtptLastBg[2] != options.background[2]);
  const bool geoMoved = (rtptLastChange != lastChange);
  const bool camSame = rtptHasHistory && sameRtptCamera(camera, rtptLastCamera);
  if (lookChanged) {
    rtptHasHistory = false;
    rtptStillFrames = 0;
  }
  if (camSame && !geoMoved && !lookChanged && rtptHasHistory) {
    rtptStillFrames++;
  } else {
    rtptStillFrames = 1;
  }
  rtptLastCamera = camera;
  rtptLastFloor = options.floor;
  rtptLastLightsFollow = options.lightsFollowCamera;
  rtptLastClay = options.clay;
  std::copy(std::begin(options.background), std::end(options.background), std::begin(rtptLastBg));

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);
  frame++;
  const int slot = static_cast<int>(frame % 3);
  flush(slot);

  // Maintain triple-buffered per-piece transforms, updating ONLY when geometry actually moved
  // so camera orbits pay zero CPU copy and zero scattered GPU vertex-shader DRAM reads.
  const uint32_t pieceCount = static_cast<uint32_t>(scene.where.size());
  if (pieceCount > 0 && rtptPoseCapacity < pieceCount) {
    rtptPoseCapacity = std::max<uint32_t>(pieceCount, 64u);
    for (int i = 0; i < 3; i++) {
      rtptPoses[i] = [dev newBufferWithLength:rtptPoseCapacity * sizeof(RtptPrevPoseGpu) options:MTLResourceStorageModeShared];
    }
    rtptHasPrevPose = false;
    rtptPrevPoseSlot = -1;
  }
  const bool updatePoses = (pieceCount > 0) && (geoMoved || !rtptHasPrevPose);
  const int curPoseSlot = updatePoses ? ((rtptPrevPoseSlot + 1) % 3) : std::max(0, rtptPrevPoseSlot);
  if (updatePoses && rtptPoses[curPoseSlot]) {
    auto* curOut = static_cast<RtptPrevPoseGpu*>(rtptPoses[curPoseSlot].contents);
    for (const Group& g : scene.groups) {
      for (const Instance& in : g.instances) {
        if (in.piece < rtptPoseCapacity) {
          curOut[in.piece].r0 = simd_make_float4(in.model[0], in.model[1], in.model[2], in.model[3]);
          curOut[in.piece].r1 = simd_make_float4(in.model[4], in.model[5], in.model[6], in.model[7]);
          curOut[in.piece].r2 = simd_make_float4(in.model[8], in.model[9], in.model[10], in.model[11]);
        }
      }
    }
  }
  id<MTLBuffer> prevPoseBuf = (rtptHasPrevPose && rtptPrevPoseSlot >= 0) ? rtptPoses[rtptPrevPoseSlot] : rtptPoses[curPoseSlot];

  // Halton(2, 3) subpixel jitter over 16 positions for crisp temporal anti-aliasing & supersampling.
  const uint32_t jitterIdx = (rtptFrameIdx % 16u) + 1u;
  const float jx = (rtptFrameIdx == 0u && !rtptHasHistory) ? 0.0f : (halton(jitterIdx, 2u) - 0.5f);
  const float jy = (rtptFrameIdx == 0u && !rtptHasHistory) ? 0.0f : (halton(jitterIdx, 3u) - 0.5f);

  const Mat4 view = viewMatrix(camera, scene.origin);
  const Mat4 proj = projectionMatrix(camera);
  Mat4 projJittered = proj;
  const float dxNdc = (2.0f * jx) / static_cast<float>(width);
  const float dyNdc = (-2.0f * jy) / static_cast<float>(height);
  if (camera.orthoHalfHeight > 0) {
    projJittered.m[12] += dxNdc;
    projJittered.m[13] += dyNdc;
  } else {
    projJittered.m[8] -= dxNdc;
    projJittered.m[9] -= dyNdc;
  }
  const simd_float4x4 vpUnjittered = simdFrom(multiply(proj, view));
  const simd_float4x4 vpJittered = simdFrom(multiply(projJittered, view));

  PathScene::Impl& ps = ptScene->impl();
  bm::Vec3 right, up, forward;
  rtptCameraBasis(camera, right, up, forward);
  const LightRig rig = studioLights(camera, options.lightsFollowCamera);
  const bm::Box& b = scene.bounds;
  bm::Box fitted = liveBounds;
  fitted.merge(scene.bounds);
  const double diagonal = fitted.empty() ? 100.0 : std::max(10.0, length(fitted.max - fitted.min));
  const bm::Vec3 middle = b.empty() ? scene.origin : (b.min + b.max) * 0.5;
  const double floorY = (b.empty() ? 0.0 : b.max.y - scene.origin.y) + kFloorLift;
  // Finer world-space SHaRC base cell so 8-LDU gaps under floating plates & stud cavities never bleed.
  const float sharcBase = std::clamp(static_cast<float>(diagonal / 96.0), 2.5f, 10.0f);

  RtptUniformsGpu ru{};
  ru.viewProjJittered = vpJittered;
  ru.viewProjUnjittered = vpUnjittered;
  ru.prevViewProj = rtptHasHistory ? rtptPrevViewProj : vpUnjittered;
  ru.eye = rtptF4(camera.eye - scene.origin, std::tan(camera.fovY / 2));
  ru.right = rtptF4(right, static_cast<double>(width) / height);
  ru.up = rtptF4(up, camera.orthoHalfHeight);
  ru.forward = rtptF4(forward, camera.near);
  for (int i = 0; i < 4; i++) {
    ru.lights[i] = rtptF4(rig.toward[i], rig.strength[i] * (i == 0 ? 1.0f : kPathFillShare));
  }
  const double cosR = std::sqrt(1.0 - kRigSinSquared);
  ru.rig = simd_make_float4(kWorldStrength, kRigSinSquared, static_cast<float>(cosR), 1.0f);
  ru.background = simd_make_float4(options.background[0], options.background[1], options.background[2], kFloorSkyPower);
  ru.floorPlane = simd_make_float4(static_cast<float>(floorY), options.floor ? 1.0f : 0.0f, kFloorKeyShare, static_cast<float>(kFloorExtent * diagonal));
  ru.floorCentre = simd_make_float4(static_cast<float>(middle.x - scene.origin.x), static_cast<float>(middle.z - scene.origin.z), 0.0f, 0.0f);
  const bm::Vec3 sMin = fitted.empty() ? bm::Vec3{-10, -10, -10} : (fitted.min - scene.origin - bm::Vec3{1, 1, 1});
  const bm::Vec3 sMax = fitted.empty() ? bm::Vec3{10, 10, 10} : (fitted.max - scene.origin + bm::Vec3{1, 1, 1});
  ru.sceneMin = rtptF4(sMin, sharcBase);
  ru.sceneMax = rtptF4(sMax, (geoMoved || lookChanged) ? 0.35f : 0.96f);
  ru.glass = simd_make_float4(kGlassIor, kGlassAbsorption, kGlassAbsorption / kPathGlassWall, kFloorThroughGlass);
  ru.jitter = simd_make_float4(jx, jy, rtptPrevJitter[0], rtptPrevJitter[1]);
  const simd_float3 accent = simd_make_float3(linearFromSrgb(kSelectionRgb[0]), linearFromSrgb(kSelectionRgb[1]), linearFromSrgb(kSelectionRgb[2]));
  ru.selection = simd_make_float4(accent.x, accent.y, accent.z, selected.empty() ? 0.0f : kSelectionWidth);
  ru.size = simd_make_uint4(static_cast<uint32_t>(width), static_cast<uint32_t>(height), rtptFrameIdx, rtptStillFrames);
  ru.flags = simd_make_uint4(ps.instances != nil ? 1u : 0u, rtptHasHistory ? 1u : 0u, geoMoved ? 1u : 0u, hasPlaceholders ? 1u : 0u);
  const uint32_t maxSamples = static_cast<uint32_t>(std::max(1, options.pathMaxSamples));
  ru.params = simd_make_uint4(maxSamples, 1u, (geoMoved && rtptHasPrevPose && prevPoseBuf != nil) ? 1u : 0u, pieceCount);

  // Fill DrawUniforms and visible instance index buffer.
  const size_t batchCount = std::max<size_t>(1, seen.size());
  id<MTLBuffer> drawBuffer = drawUniforms.get(dev, frame, batchCount * sizeof(DrawUniforms));
  auto* du = static_cast<DrawUniforms*>(drawBuffer.contents);
  for (size_t i = 0; i < seen.size(); i++) {
    const Batch& batch = seen[i];
    const Group& group = scene.groups[batch.group];
    const Material& m = group.material;
    du[i].base = simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha);
    du[i].surface = simd_make_float4(m.roughness, m.metalness, m.clearcoat, group.placeholder ? 1.0f : 0.0f);
    du[i].edge = simd_make_float4(m.edge[0], m.edge[1], m.edge[2], kEdgeOpacity);
    if (options.clay && !group.placeholder) {
      du[i].base = simd_make_float4(0.56f, 0.58f, 0.6f, 1.0f);
      du[i].surface = simd_make_float4(0.57f, 0.0f, 0.1f, 0.0f);
    }
    du[i].flip = simd_make_float4(batch.mirrored ? -1.0f : 1.0f, batch.detail == Detail::Box ? 2.0f : 1.0f, 0.0f, 0.0f);
    du[i].sphere = simd_make_float4(0, 0, 0, 0);
  }
  id<MTLBuffer> visibleBuffer = visible.get(dev, frame, std::max<size_t>(1, list.size()) * sizeof(uint32_t));
  if (!list.empty()) std::memcpy(visibleBuffer.contents, list.data(), list.size() * sizeof(uint32_t));

  // Ping-pong indices for temporal textures.
  const int cur = static_cast<int>(rtptFrameIdx & 1u);
  const int prev = cur ^ 1;
  const MTLSize grid = MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1);
  const MTLSize tg = MTLSizeMake(8, 8, 1);

  id<MTLCommandBuffer> commands = [device->queue commandBuffer];
  const bool profile = std::getenv("BM_RTPT_PROFILE") != nullptr;
  auto submitStage = [&](const char* label) {
    if (!profile) return;
    [commands commit];
    [commands waitUntilCompleted];
    const double ms = (commands.GPUEndTime - commands.GPUStartTime) * 1000.0;
    if (rtptFrameIdx == 15u) std::fprintf(stderr, "rtpt-prof %-18s %6.2f ms\n", label, ms);
    commands = [device->queue commandBuffer];
  };

  // Reset SHaRC table cleanly on look switches (e.g. clay/background change).
  if (lookChanged) {
    id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
    [blit fillBuffer:rtptSharcAccum range:NSMakeRange(0, rtptSharcAccum.length) value:0];
    [blit fillBuffer:rtptSharcResolved range:NSMakeRange(0, rtptSharcResolved.length) value:0];
    [blit endEncoding];
  }

  // ---- PASS 1: Rasterize Full-Resolution Primary G-Buffer + Motion Vectors ----
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = rtptPosId[cur];
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    pass.colorAttachments[1].texture = rtptNorm[cur];
    pass.colorAttachments[1].loadAction = MTLLoadActionClear;
    pass.colorAttachments[1].clearColor = MTLClearColorMake(0, 0, 0, 0);
    pass.colorAttachments[1].storeAction = MTLStoreActionStore;
    pass.colorAttachments[2].texture = rtptMat;
    pass.colorAttachments[2].loadAction = MTLLoadActionClear;
    pass.colorAttachments[2].clearColor = MTLClearColorMake(0, 0, 0, 0);
    pass.colorAttachments[2].storeAction = MTLStoreActionStore;
    pass.colorAttachments[3].texture = rtptMotion;
    pass.colorAttachments[3].loadAction = MTLLoadActionClear;
    pass.colorAttachments[3].clearColor = MTLClearColorMake(0, 0, 0, 0);
    pass.colorAttachments[3].storeAction = MTLStoreActionStore;
    pass.depthAttachment.texture = rtptDepth;
    pass.depthAttachment.loadAction = MTLLoadActionClear;
    pass.depthAttachment.clearDepth = 0.0;  // reversed-Z
    pass.depthAttachment.storeAction = MTLStoreActionStore;

    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setDepthStencilState:pipelines.depthWrite];
    [enc setVertexBytes:&ru length:sizeof(ru) atIndex:1];
    [enc setFragmentBytes:&ru length:sizeof(ru) atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setFragmentBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    if (prevPoseBuf) [enc setVertexBuffer:prevPoseBuf offset:0 atIndex:5];

    auto drawBatches = [&](bool transparentPass) {
      [enc setRenderPipelineState:transparentPass ? pipelines.rtptGbufGlass : pipelines.rtptGbufOpaque];
      [enc setCullMode:MTLCullModeBack];
      for (size_t i = 0; i < seen.size(); i++) {
        const Batch& batch = seen[i];
        const Group& group = scene.groups[batch.group];
        const bool isTrans = group.placeholder || (group.material.transparent() && !options.clay);
        if (isTrans != transparentPass) continue;
        const GpuMesh& gpu = mesh(group, batch.detail);
        if (!gpu.indexCount) continue;
        [enc setFrontFacingWinding:batch.mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
        [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
        [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
        [enc setVertexBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setFragmentBufferOffset:i * sizeof(DrawUniforms) atIndex:2];
        [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
        const uint32_t indices = batch.top ? gpu.topIndexCount : gpu.indexCount;
        if (!indices) continue;
        [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:indices indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
        stats.drawCalls++;
        stats.instances += batch.count;
        stats.triangles += static_cast<uint64_t>(indices / 3) * batch.count;
        stats.byDetail[static_cast<int>(batch.detail)] += batch.count;
      }
    };

    // 1. Opaque bricks
    drawBatches(false);

    // 2. Floor shadow-catcher plane
    if (options.floor) {
      [enc setRenderPipelineState:pipelines.rtptGbufFloor];
      [enc setCullMode:MTLCullModeNone];
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
    }

    // 3. Transparent glass & placeholder front faces
    drawBatches(true);
    [enc endEncoding];
  }
  submitStage("1_gbuffer");

  // Optional selection mask (only when pieces are selected).
  if (!selected.empty() && mask) {
    FrameUniforms fu{};
    fu.viewProj = vpUnjittered;
    MTLRenderPassDescriptor* mp = [MTLRenderPassDescriptor new];
    mp.colorAttachments[0].texture = mask;
    mp.colorAttachments[0].loadAction = MTLLoadActionClear;
    mp.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
    mp.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:mp];
    [enc setRenderPipelineState:pipelines.mask];
    [enc setCullMode:MTLCullModeNone];
    [enc setVertexBytes:&fu length:sizeof(fu) atIndex:1];
    [enc setVertexBuffer:drawBuffer offset:0 atIndex:2];
    [enc setVertexBuffer:visibleBuffer offset:0 atIndex:4];
    for (const Batch& batch : selected) {
      const GpuMesh& gpu = mesh(scene.groups[batch.group], batch.detail);
      if (!gpu.indexCount) continue;
      [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
      [enc setVertexBuffer:instanceBuffers[batch.group][slot] offset:0 atIndex:3];
      [enc setVertexBufferOffset:batch.first * sizeof(uint32_t) atIndex:4];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32 indexBuffer:gpu.indices indexBufferOffset:0 instanceCount:batch.count];
    }
    [enc endEncoding];
  }

  // Helper to bind PathScene BLAS/TLAS resources to a compute encoder.
  auto bindScene = [&](id<MTLComputeCommandEncoder> ce) {
    if (ps.instances) {
      [ce setAccelerationStructure:ps.instances atBufferIndex:1];
      for (const PartStructure& p : ps.structures) {
        [ce useResource:p.structure usage:MTLResourceUsageRead];
        [ce useResource:p.vertices usage:MTLResourceUsageRead];
        [ce useResource:p.indices usage:MTLResourceUsageRead];
      }
      [ce setBuffer:ps.instanceTable offset:0 atIndex:2];
      [ce setBuffer:ps.meshTable offset:0 atIndex:3];
    }
    if (ps.materialTable) [ce setBuffer:ps.materialTable offset:0 atIndex:4];
  };

  // ---- PASSES 3, 4, 5, 6: Compute Pipeline ----
  {
    id<MTLComputeCommandEncoder> ce = [commands computeCommandEncoder];

    // Pass 3: Exact Analytical Adaptive Control-Variate Studio Direct Lighting (0 bias, 0 noise on sunlit faces)
    [ce setComputePipelineState:pipelines.rtptDirectPass];
    [ce setBytes:&ru length:sizeof(ru) atIndex:0];
    bindScene(ce);
    [ce setTexture:rtptPosId[cur] atIndex:0];
    [ce setTexture:rtptNorm[cur] atIndex:1];
    [ce setTexture:rtptMotion atIndex:2];
    [ce setTexture:rtptPosId[prev] atIndex:3];
    [ce setTexture:rtptNorm[prev] atIndex:4];
    [ce setTexture:rtptDiffHist[prev] atIndex:5];
    [ce setTexture:rtptDi atIndex:6];
    [ce dispatchThreads:grid threadsPerThreadgroup:tg];
    if (profile) { [ce endEncoding]; submitStage("3_direct_cv"); ce = [commands computeCommandEncoder]; }

    // Pass 4a: Full-Resolution Adaptive Control-Variate Floor Shadow Catcher (razor-sharp contact creases!)
    if (options.floor) {
      [ce setComputePipelineState:pipelines.rtptTraceFloor];
      [ce setBytes:&ru length:sizeof(ru) atIndex:0];
      bindScene(ce);
      [ce setTexture:rtptPosId[cur] atIndex:0];
      [ce setTexture:rtptMotion atIndex:1];
      [ce setTexture:rtptPosId[prev] atIndex:2];
      [ce setTexture:rtptDiffHist[prev] atIndex:3];
      [ce setTexture:rtptDiffRaw atIndex:4];
      [ce dispatchThreads:grid threadsPerThreadgroup:tg];
      if (profile) { [ce endEncoding]; submitStage("4a_trace_floor"); ce = [commands computeCommandEncoder]; }
    }

    // Pass 4b: Specialized Opaque Brick GI (+ Fine SHaRC + 2nd-Bounce) + Separate Deterministic Clearcoat & Base VNDF Specular
    [ce setComputePipelineState:pipelines.rtptTraceOpaque];
    [ce setBytes:&ru length:sizeof(ru) atIndex:0];
    bindScene(ce);
    [ce setBuffer:rtptSharcResolved offset:0 atIndex:5];
    [ce setBuffer:rtptSharcAccum offset:0 atIndex:6];
    [ce setTexture:rtptPosId[cur] atIndex:0];
    [ce setTexture:rtptNorm[cur] atIndex:1];
    [ce setTexture:rtptMat atIndex:2];
    [ce setTexture:rtptMotion atIndex:3];
    [ce setTexture:rtptDi atIndex:4];
    [ce setTexture:rtptDiffRaw atIndex:5];
    [ce setTexture:rtptSpecRaw atIndex:6];
    [ce dispatchThreads:grid threadsPerThreadgroup:tg];
    if (profile) { [ce endEncoding]; submitStage("4b_trace_opaque"); ce = [commands computeCommandEncoder]; }

    // Pass 4c: Specialized Deterministic-Fresnel 16-Bounce Dielectric Glass RT (dispatched ONLY when glass is in view!)
    if (glassInView) {
      [ce setComputePipelineState:pipelines.rtptTraceGlass];
      [ce setBytes:&ru length:sizeof(ru) atIndex:0];
      bindScene(ce);
      [ce setBuffer:rtptSharcResolved offset:0 atIndex:5];
      [ce setBuffer:rtptSharcAccum offset:0 atIndex:6];
      [ce setTexture:rtptPosId[cur] atIndex:0];
      [ce setTexture:rtptSpecRaw atIndex:1];
      [ce dispatchThreads:grid threadsPerThreadgroup:tg];
      if (profile) { [ce endEncoding]; submitStage("4c_trace_glass"); ce = [commands computeCommandEncoder]; }
    }

    // Pass 2b: Resolve SHaRC atomic radiance updates for next frame's multi-bounce lookup
    [ce setComputePipelineState:pipelines.rtptSharcResolve];
    [ce setBytes:&ru length:sizeof(ru) atIndex:0];
    [ce setBuffer:rtptSharcAccum offset:0 atIndex:1];
    [ce setBuffer:rtptSharcResolved offset:0 atIndex:2];
    [ce dispatchThreads:MTLSizeMake(kRtptSharcCap, 1, 1) threadsPerThreadgroup:MTLSizeMake(64, 1, 1)];
    if (profile) { [ce endEncoding]; submitStage("2b_sharc_resolve"); ce = [commands computeCommandEncoder]; }

    // Pass 5a: Demodulated SVGF Temporal Accumulation + Variance Estimation
    [ce setComputePipelineState:pipelines.rtptSvgfTemporal];
    [ce setBytes:&ru length:sizeof(ru) atIndex:0];
    [ce setTexture:rtptPosId[cur] atIndex:0];
    [ce setTexture:rtptNorm[cur] atIndex:1];
    [ce setTexture:rtptMotion atIndex:2];
    [ce setTexture:rtptPosId[prev] atIndex:3];
    [ce setTexture:rtptNorm[prev] atIndex:4];
    [ce setTexture:rtptDiffRaw atIndex:5];
    [ce setTexture:rtptSpecRaw atIndex:6];
    [ce setTexture:rtptDiffHist[prev] atIndex:7];
    [ce setTexture:rtptSpecHist[prev] atIndex:8];
    [ce setTexture:rtptMoments[prev] atIndex:9];
    [ce setTexture:rtptHLen[prev] atIndex:10];
    [ce setTexture:rtptDiffHist[cur] atIndex:11];
    [ce setTexture:rtptSpecHist[cur] atIndex:12];
    [ce setTexture:rtptMoments[cur] atIndex:13];
    [ce setTexture:rtptHLen[cur] atIndex:14];
    [ce dispatchThreads:grid threadsPerThreadgroup:tg];
    if (profile) { [ce endEncoding]; submitStage("5a_svgf_temporal"); ce = [commands computeCommandEncoder]; }

    // Pass 5b: 4-Pass 5-Tap Alternating Cross/Diagonal Plane-Distance A-Trous Denoiser (skips glass & sharp sheen!)
    id<MTLTexture> diffSrc = rtptDiffHist[cur];
    id<MTLTexture> specSrc = rtptSpecHist[cur];
    id<MTLTexture> diffDst = rtptDiffPing;
    id<MTLTexture> specDst = rtptSpecPing;
    const uint32_t steps[4] = {1u, 2u, 4u, 8u};
    [ce setComputePipelineState:pipelines.rtptSvgfAtrous];
    [ce setTexture:rtptPosId[cur] atIndex:0];
    [ce setTexture:rtptNorm[cur] atIndex:1];
    [ce setTexture:rtptMat atIndex:2];
    [ce setTexture:rtptMoments[cur] atIndex:5];
    [ce setTexture:rtptHLen[cur] atIndex:6];
    for (int p = 0; p < 4; p++) {
      ru.params.y = steps[p] | (static_cast<uint32_t>(p) << 16u);
      [ce setBytes:&ru length:sizeof(ru) atIndex:0];
      [ce setTexture:diffSrc atIndex:3];
      [ce setTexture:specSrc atIndex:4];
      [ce setTexture:diffDst atIndex:7];
      [ce setTexture:specDst atIndex:8];
      [ce dispatchThreads:grid threadsPerThreadgroup:tg];
      diffSrc = diffDst;
      specSrc = specDst;
      diffDst = ((p & 1) == 0) ? rtptDiffPong : rtptDiffPing;
      specDst = ((p & 1) == 0) ? rtptSpecPong : rtptSpecPing;
    }
    if (profile) { [ce endEncoding]; submitStage("5b_svgf_atrous"); ce = [commands computeCommandEncoder]; }

    // Pass 6a: Cooperative Threadgroup-SRAM BRDF Re-Modulation + Halton TAA / Unbiased Cesaro Progressive Resolve
    [ce setComputePipelineState:pipelines.rtptResolveTaa];
    [ce setBytes:&ru length:sizeof(ru) atIndex:0];
    [ce setTexture:rtptPosId[cur] atIndex:0];
    [ce setTexture:rtptNorm[cur] atIndex:1];
    [ce setTexture:rtptMat atIndex:2];
    [ce setTexture:rtptMotion atIndex:3];
    [ce setTexture:diffSrc atIndex:4];
    [ce setTexture:specSrc atIndex:5];
    [ce setTexture:rtptTaa[prev] atIndex:6];
    [ce setTexture:rtptTaa[cur] atIndex:7];
    [ce dispatchThreadgroups:MTLSizeMake((static_cast<NSUInteger>(width) + 7) / 8,
                                         (static_cast<NSUInteger>(height) + 7) / 8, 1)
        threadsPerThreadgroup:tg];
    [ce endEncoding];
    submitStage("6a_resolve_taa");
  }

  // Pass 6b: Present to BGRA8Unorm_sRGB target + selection outline
  {
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.rtptPresent];
    [enc setFragmentBytes:&ru length:sizeof(ru) atIndex:0];
    [enc setFragmentTexture:rtptTaa[cur] atIndex:0];
    [enc setFragmentTexture:mask ? mask : rtptTaa[cur] atIndex:1];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  // Keep pick map & previous-frame pose state synchronized.
  drewFrame = true, idsReady = false, lastSlot = slot, lastCamera = camera;
  lastList.swap(list);
  lastSeen.swap(seen);

  if (updatePoses && rtptPoses[curPoseSlot]) {
    rtptPrevPoseSlot = curPoseSlot;
    rtptHasPrevPose = true;
  }

  rtptPrevViewProj = vpUnjittered;
  rtptPrevJitter[0] = jx;
  rtptPrevJitter[1] = jy;
  rtptHasHistory = true;
  rtptLastChange = lastChange;
  rtptFrameIdx++;

  dispatch_semaphore_t done = inFlight;
  std::atomic<double>* gpu = &gpuMs;
  [commands addCompletedHandler:^(id<MTLCommandBuffer> finished) {
    gpu->store((finished.GPUEndTime - finished.GPUStartTime) * 1000.0);
    dispatch_semaphore_signal(done);
  }];
  if (drawable) [commands presentDrawable:drawable];
  [commands commit];

  stats.submitted = true;
  stats.pathSamples = rtptStillFrames;
  stats.settling = (rtptStillFrames < maxSamples);
  stats.cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  if (!drawable) {
    [commands waitUntilCompleted];
    stats.gpuMs = (commands.GPUEndTime - commands.GPUStartTime) * 1000.0;
    drewOffscreen = true;
  }
  return stats;
}

}  // namespace bmr
