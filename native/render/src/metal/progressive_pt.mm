// Live progressive hardware-RT path tracing inside the interactive viewport:
// keeps Metal BLAS/TLAS acceleration structures and accumulation buffers persistent across frames,
// accumulates 1-2 samples/frame with exact bmexport quality, and runs Metal OIDN at convergence
// milestones so the viewport snaps to noise-free offline quality in < 0.3s while staying responsive.
#import "metal/impl.h"
#import "metal/path_impl.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include "bmr/denoise.h"
#include "bmr/tolerances.h"

namespace bmr {

namespace {
struct PtUniformsGpu {
  simd_float4 eye, right, up, forward;
  simd_float4 lights[4];
  simd_float4 rig, background, floorPlane, glass;
  simd_uint4 size, seed;
};

struct PathResolveUniformsGpu {
  uint32_t width;
  uint32_t height;
  uint32_t samples;
  uint32_t useDenoised;
  simd_float4 background;
};

simd_float4 ptF4(bm::Vec3 v, double w) {
  return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), static_cast<float>(w));
}

bool sameCamera(const Camera& a, const Camera& b) {
  auto eq = [](double x, double y) { return std::abs(x - y) <= 1e-6; };
  auto eq3 = [&](bm::Vec3 u, bm::Vec3 v) { return eq(u.x, v.x) && eq(u.y, v.y) && eq(u.z, v.z); };
  return eq3(a.eye, b.eye) && eq3(a.target, b.target) && eq3(a.up, b.up) && eq(a.fovY, b.fovY) && eq(a.aspect, b.aspect) && eq(a.orthoHalfHeight, b.orthoHalfHeight);
}

void ptCameraBasis(const Camera& c, bm::Vec3& right, bm::Vec3& up, bm::Vec3& forward) {
  forward = c.target - c.eye;
  forward = bm::length(forward) > 1e-12 ? bm::normalized(forward) : bm::Vec3{0, 0, -1};
  right = bm::cross(forward, c.up);
  if (!(bm::length(right) > 1e-9)) right = bm::cross(forward, std::abs(forward.x) < 0.9 ? bm::Vec3{1, 0, 0} : bm::Vec3{0, 0, 1});
  right = bm::normalized(right);
  up = bm::cross(right, forward);
}
}  // namespace

FrameStats Renderer::Impl::drawPathTraced(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable) {
  FrameStats stats;
  const auto started = std::chrono::steady_clock::now();
  id<MTLTexture> target = drawable ? drawable.texture : final;
  if (!target || width < 1 || height < 1 || !pipelines.pathTrace || !pipelines.pathResolve) return stats;

  if (!ptInitTried) {
    ptInitTried = true;
    std::string err;
    ptScene = PathScene::create(&err);
  }
  if (!ptScene) return stats;

  // Rebuild instanced Metal TLAS only when scene geometry/poses changed (BLAS is cached per part).
  const bool sceneChanged = (ptSceneRevision != lastChange);
  if (sceneChanged) {
    ptScene->prepare(scene, *meshes);
    ptSceneRevision = lastChange;
    ptSamples = 0;
    ptHasDenoised = false;
  }

  const size_t pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
  const bool sizeChanged = (ptW != width || ptH != height || !ptAccum || !ptDenoised);
  if (sizeChanged) {
    id<MTLDevice> dev = device->device;
    auto mkBuf = [&]() { return [dev newBufferWithLength:pixels * sizeof(simd_float4) options:MTLResourceStorageModeShared]; };
    ptAccum = mkBuf(), ptCatcher = mkBuf(), ptSky = mkBuf(), ptAlbedo = mkBuf(), ptNormal = mkBuf();
    MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA32Float width:static_cast<NSUInteger>(width) height:static_cast<NSUInteger>(height) mipmapped:NO];
    td.usage = MTLTextureUsageShaderRead;
    td.storageMode = MTLStorageModeShared;
    ptDenoised = [dev newTextureWithDescriptor:td];
    ptW = width, ptH = height;
    ptSamples = 0;
    ptHasDenoised = false;
  }

  const bool viewChanged = !sameCamera(camera, ptCamera) || ptFloor != options.floor || ptLightsFollow != options.lightsFollowCamera ||
                           ptBg[0] != options.background[0] || ptBg[1] != options.background[1] || ptBg[2] != options.background[2];
  if (viewChanged) {
    ptCamera = camera;
    ptFloor = options.floor;
    ptLightsFollow = options.lightsFollowCamera;
    std::copy(std::begin(options.background), std::end(options.background), std::begin(ptBg));
    ptSamples = 0;
    ptHasDenoised = false;
  }

  const uint32_t maxSamples = static_cast<uint32_t>(std::max(1, options.pathMaxSamples));
  const uint32_t sppPerFrame = static_cast<uint32_t>(std::max(1, options.pathSamplesPerFrame));
  const bool needTrace = ptSamples < maxSamples;

  dispatch_semaphore_wait(inFlight, DISPATCH_TIME_FOREVER);

  id<MTLCommandBuffer> commands = [device->queue commandBuffer];
  if (needTrace && ptSamples == 0) {
    id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
    const NSRange all = NSMakeRange(0, pixels * sizeof(simd_float4));
    [blit fillBuffer:ptAccum range:all value:0];
    [blit fillBuffer:ptCatcher range:all value:0];
    [blit fillBuffer:ptSky range:all value:0];
    [blit fillBuffer:ptAlbedo range:all value:0];
    [blit fillBuffer:ptNormal range:all value:0];
    [blit endEncoding];
  }

  uint32_t tracedThisFrame = 0;
  if (needTrace) {
    PathScene::Impl& s = ptScene->impl();
    tracedThisFrame = std::min(sppPerFrame, maxSamples - ptSamples);
    PtUniformsGpu u{};
    bm::Vec3 right, up, forward;
    ptCameraBasis(camera, right, up, forward);
    u.eye = ptF4(camera.eye - s.origin, std::tan(camera.fovY / 2));
    u.right = ptF4(right, static_cast<double>(width) / height);
    u.up = ptF4(up, 0);
    u.forward = ptF4(forward, 0);
    const LightRig rig = studioLights(camera, options.lightsFollowCamera);
    for (int i = 0; i < 4; i++) u.lights[i] = ptF4(rig.toward[i], rig.strength[i] * (i == 0 ? 1.0f : kPathFillShare));
    u.rig = simd_make_float4(kWorldStrength, kRigSinSquared, std::sqrt(1.0f - kRigSinSquared), 1.0f);
    u.background = simd_make_float4(options.background[0], options.background[1], options.background[2], 1.0f);
    u.floorPlane = simd_make_float4(s.floorY, options.floor ? 1.0f : 0.0f, kFloorKeyShare, 0.0f);
    u.glass = simd_make_float4(kGlassIor, kGlassAbsorption, kGlassAbsorption / kPathGlassWall, kFloorThroughGlass);
    const bool hasScene = s.instances != nil;
    u.seed = simd_make_uint4(0u, 0u, hasScene ? 1u : 0u, kPathMaxBounces);
    u.size = simd_make_uint4(static_cast<uint32_t>(width), static_cast<uint32_t>(height), tracedThisFrame, ptSamples);

    id<MTLComputeCommandEncoder> enc = [commands computeCommandEncoder];
    [enc setComputePipelineState:pipelines.pathTrace];
    [enc setBytes:&u length:sizeof(u) atIndex:0];
    if (hasScene) {
      [enc setAccelerationStructure:s.instances atBufferIndex:1];
      for (const PartStructure& p : s.structures) {
        [enc useResource:p.structure usage:MTLResourceUsageRead];
        [enc useResource:p.vertices usage:MTLResourceUsageRead];
        [enc useResource:p.indices usage:MTLResourceUsageRead];
      }
      [enc setBuffer:s.instanceTable offset:0 atIndex:2];
      [enc setBuffer:s.meshTable offset:0 atIndex:3];
    }
    [enc setBuffer:s.materialTable offset:0 atIndex:4];
    [enc setBuffer:ptAccum offset:0 atIndex:5];
    [enc setBuffer:ptCatcher offset:0 atIndex:6];
    [enc setBuffer:ptAlbedo offset:0 atIndex:7];
    [enc setBuffer:ptNormal offset:0 atIndex:8];
    [enc setBuffer:ptSky offset:0 atIndex:9];
    [enc dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
    [enc endEncoding];
    ptSamples += tracedThisFrame;
  }

  // Run Metal OIDN denoise at clean convergence milestones (8 spp, 32 spp, and final maxSamples)
  // so the live viewport snaps to noise-free offline quality in ~0.3s and refines cleanly.
  const bool runDenoise = needTrace && denoiserAvailable() && (ptSamples == 8 || ptSamples == 32 || ptSamples == maxSamples);
  if (runDenoise) {
    [commands commit];
    [commands waitUntilCompleted];

    PathImage img;
    img.width = width, img.height = height;
    img.beauty.resize(pixels * 3), img.albedo.resize(pixels * 3), img.normal.resize(pixels * 3);
    const auto* a = static_cast<const simd_float4*>(ptAccum.contents);
    const auto* c = static_cast<const simd_float4*>(ptCatcher.contents);
    const auto* w = static_cast<const simd_float4*>(ptSky.contents);
    const auto* al = static_cast<const simd_float4*>(ptAlbedo.contents);
    const auto* n = static_cast<const simd_float4*>(ptNormal.contents);
    const float inv = 1.0f / static_cast<float>(ptSamples);
    for (size_t i = 0; i < pixels; i++) {
      const float floorShare = a[i].w;
      for (int k = 0; k < 3; k++) {
        const float lights = c[i].w > 0 ? c[i][k] / c[i].w : 1.0f, world = w[i].w > 0 ? w[i][k] / w[i].w : 1.0f;
        const float ratio = lights * std::pow(world, kFloorSkyPower);
        img.beauty[i * 3 + k] = (a[i][k] + floorShare * options.background[k] * ratio) * inv;
        img.albedo[i * 3 + k] = al[i][k] * inv;
      }
      const simd_float3 sum = simd_make_float3(n[i].x, n[i].y, n[i].z);
      const float len = simd_length(sum);
      for (int k = 0; k < 3; k++) img.normal[i * 3 + k] = len > 1e-6f ? sum[k] / len : 0.0f;
    }
    std::string derr;
    if (denoise(img, DenoiseDevice::Metal, &derr)) {
      std::vector<float> rgba(pixels * 4);
      for (size_t i = 0; i < pixels; i++) {
        rgba[i * 4 + 0] = img.beauty[i * 3 + 0];
        rgba[i * 4 + 1] = img.beauty[i * 3 + 1];
        rgba[i * 4 + 2] = img.beauty[i * 3 + 2];
        rgba[i * 4 + 3] = 1.0f;
      }
      [ptDenoised replaceRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(width), static_cast<NSUInteger>(height))
                    mipmapLevel:0
                      withBytes:rgba.data()
                    bytesPerRow:static_cast<NSUInteger>(width) * 4 * sizeof(float)];
      ptHasDenoised = true;
    }
    commands = [device->queue commandBuffer];
  }

  // Resolve to target (either denoised snapshot once available, or live progressive accumulation).
  {
    PathResolveUniformsGpu ru{};
    ru.width = static_cast<uint32_t>(width);
    ru.height = static_cast<uint32_t>(height);
    ru.samples = ptSamples;
    ru.useDenoised = ptHasDenoised ? 1u : 0u;
    ru.background = simd_make_float4(options.background[0], options.background[1], options.background[2], kFloorSkyPower);

    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor new];
    pass.colorAttachments[0].texture = target;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc = [commands renderCommandEncoderWithDescriptor:pass];
    [enc setRenderPipelineState:pipelines.pathResolve];
    [enc setFragmentBytes:&ru length:sizeof(ru) atIndex:0];
    [enc setFragmentBuffer:ptAccum offset:0 atIndex:1];
    [enc setFragmentBuffer:ptCatcher offset:0 atIndex:2];
    [enc setFragmentBuffer:ptSky offset:0 atIndex:3];
    [enc setFragmentTexture:ptDenoised atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
  }

  dispatch_semaphore_t done = inFlight;
  std::atomic<double>* gpu = &gpuMs;
  [commands addCompletedHandler:^(id<MTLCommandBuffer> finished) {
    gpu->store((finished.GPUEndTime - finished.GPUStartTime) * 1000.0);
    dispatch_semaphore_signal(done);
  }];
  if (drawable) [commands presentDrawable:drawable];
  [commands commit];

  stats.submitted = true;
  stats.pathSamples = ptSamples;
  stats.settling = (ptSamples < maxSamples);
  stats.cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  if (!drawable) {
    [commands waitUntilCompleted];
    stats.gpuMs = (commands.GPUEndTime - commands.GPUStartTime) * 1000.0;
    drewOffscreen = true;
  }
  return stats;
}

}  // namespace bmr
