#import "metal/path_impl.h"

#include <algorithm>
#include <cmath>
#include "bmr/path_tracer.h"
#include "bmr/tolerances.h"

namespace bmr {

namespace {
/// As uniforms in path_trace.metal (PtUniforms).
struct PtUniformsGpu {
  simd_float4 eye, right, up, forward;
  simd_float4 lights[4];
  simd_float4 rig, background, floorPlane, glass;
  simd_uint4 size, seed;
};

simd_float4 f4(bm::Vec3 v, double w) { return simd_make_float4(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), static_cast<float>(w)); }

/// The camera's right, up and forward, as viewMatrix makes them.
void cameraBasis(const Camera& c, bm::Vec3& right, bm::Vec3& up, bm::Vec3& forward) {
  forward = c.target - c.eye;
  forward = bm::length(forward) > 1e-12 ? bm::normalized(forward) : bm::Vec3{0, 0, -1};
  right = bm::cross(forward, c.up);
  if (!(bm::length(right) > 1e-9)) right = bm::cross(forward, std::abs(forward.x) < 0.9 ? bm::Vec3{1, 0, 0} : bm::Vec3{0, 0, 1});
  right = bm::normalized(right);
  up = bm::cross(right, forward);
}
}  // namespace

struct PathTracer::Impl {
  Device* device = nullptr;
  id<MTLComputePipelineState> pipeline = nil;
};

std::unique_ptr<PathTracer> PathTracer::create(std::string* error) {
  Device* device = sharedDevice();
  if (!device) {
    if (error) *error = "no Metal device, or its shaders do not compile";
    return nullptr;
  }
  id<MTLFunction> function = [device->library newFunctionWithName:@"pathTrace"];
  NSError* failure = nil;
  id<MTLComputePipelineState> pipeline = function ? [device->device newComputePipelineStateWithFunction:function error:&failure] : nil;
  if (!pipeline) {
    if (error) *error = failure ? failure.localizedDescription.UTF8String : "no pathTrace kernel";
    return nullptr;
  }
  auto impl = std::make_unique<Impl>();
  impl->device = device;
  impl->pipeline = pipeline;
  return std::unique_ptr<PathTracer>(new PathTracer(std::move(impl)));
}

PathTracer::PathTracer(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
PathTracer::~PathTracer() = default;

PathImage PathTracer::render(PathScene& pathScene, const Camera& camera, const PathOptions& o) {
  PathImage out;
  if (o.width <= 0 || o.height <= 0 || o.samples <= 0) return out;
  PathScene::Impl& s = pathScene.impl();
  id<MTLDevice> dev = impl_->device->device;
  const size_t pixels = static_cast<size_t>(o.width) * static_cast<size_t>(o.height);
  auto zeroed = [&]() {
    id<MTLBuffer> b = [dev newBufferWithLength:pixels * sizeof(simd_float4) options:MTLResourceStorageModeShared];
    std::fill_n(static_cast<float*>(b.contents), pixels * 4, 0.0f);
    return b;
  };
  id<MTLBuffer> accum = zeroed(), catcher = zeroed(), albedo = zeroed(), normal = zeroed();

  PtUniformsGpu u{};
  bm::Vec3 right, up, forward;
  cameraBasis(camera, right, up, forward);
  u.eye = f4(camera.eye - s.origin, std::tan(camera.fovY / 2));
  u.right = f4(right, static_cast<double>(o.width) / o.height);
  u.up = f4(up, 0);
  u.forward = f4(forward, 0);
  const LightRig rig = studioLights(camera, o.lightsFollowCamera);
  for (int i = 0; i < 4; i++) u.lights[i] = f4(rig.toward[i], rig.strength[i]);
  u.rig = simd_make_float4(kWorldStrength, kRigSinSquared, std::sqrt(1.0f - kRigSinSquared), o.lights ? 1.0f : 0.0f);
  u.background = simd_make_float4(o.background[0], o.background[1], o.background[2], 1);
  u.floorPlane = simd_make_float4(s.floorY, o.floor ? 1.0f : 0.0f, 0, 0);
  u.glass = simd_make_float4(kGlassIor, kGlassAbsorption, kGlassAbsorption / kPathGlassWall, kFloorThroughGlass);
  const bool hasScene = s.instances != nil;
  u.seed = simd_make_uint4(static_cast<uint32_t>(o.seed), static_cast<uint32_t>(o.seed >> 32), hasScene ? 1u : 0u, kPathMaxBounces);

  // A few samples a dispatch, so no one command runs long; each pixel sums its own samples in order.
  const int perPass = std::max(1, std::min(o.samples, static_cast<int>(kPathRaysPerPass / pixels)));
  id<MTLCommandBuffer> last = nil;
  for (int first = 0; first < o.samples; first += perPass) {
    u.size = simd_make_uint4(static_cast<uint32_t>(o.width), static_cast<uint32_t>(o.height), static_cast<uint32_t>(std::min(perPass, o.samples - first)), static_cast<uint32_t>(first));
    id<MTLCommandBuffer> commands = [impl_->device->queue commandBuffer];
    id<MTLComputeCommandEncoder> enc = [commands computeCommandEncoder];
    [enc setComputePipelineState:impl_->pipeline];
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
    [enc setBuffer:accum offset:0 atIndex:5];
    [enc setBuffer:catcher offset:0 atIndex:6];
    [enc setBuffer:albedo offset:0 atIndex:7];
    [enc setBuffer:normal offset:0 atIndex:8];
    [enc dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(o.width), static_cast<NSUInteger>(o.height), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
    [enc endEncoding];
    [commands commit];
    last = commands;
  }
  [last waitUntilCompleted];

  out.width = o.width, out.height = o.height;
  out.beauty.resize(pixels * 3), out.albedo.resize(pixels * 3), out.normal.resize(pixels * 3);
  const auto* a = static_cast<const simd_float4*>(accum.contents);
  const auto* c = static_cast<const simd_float4*>(catcher.contents);
  const auto* al = static_cast<const simd_float4*>(albedo.contents);
  const auto* n = static_cast<const simd_float4*>(normal.contents);
  const float inv = 1.0f / static_cast<float>(o.samples);
  for (size_t i = 0; i < pixels; i++) {
    const float floorShare = a[i].w;
    for (int k = 0; k < 3; k++) {
      const float ratio = c[i].w > 0 ? c[i][k] / c[i].w : 1.0f;
      out.beauty[i * 3 + k] = (a[i][k] + floorShare * o.background[k] * ratio) * inv;
      out.albedo[i * 3 + k] = al[i][k] * inv;
    }
    const simd_float3 sum = simd_make_float3(n[i].x, n[i].y, n[i].z);
    const float len = simd_length(sum);
    for (int k = 0; k < 3; k++) out.normal[i * 3 + k] = len > 1e-6f ? sum[k] / len : 0.0f;
  }
  return out;
}

}  // namespace bmr
