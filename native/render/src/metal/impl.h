// Private to bmrender's Metal half: everything the renderer owns on the GPU.
#pragma once
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <map>
#include <simd/simd.h>
#include <string>
#include <vector>
#include "bmr/render_mesh.h"
#include "bmr/renderer.h"
#include "metal/device.h"

namespace bmr {

// Must match FrameUniforms in shaders/common.metal field for field.
struct FrameUniforms {
  simd_float4x4 viewProj;
  simd_float4x4 shadowProj;
  simd_float4 eye;
  simd_float4 keyDirection;
  simd_float4 background;
  simd_float4 viewport;
  simd_float4 room;
  simd_float4 switches;
  simd_float4 floorPlane;
  simd_float4 floorCentre;
  simd_float4 lens;
};

// Must match DrawUniforms in shaders/common.metal.
struct DrawUniforms {
  simd_float4 base;
  simd_float4 surface;
  simd_float4 edge;
  simd_float4 flip;
  simd_float4 sphere;
};

/// A part's mesh at one level of detail, on the GPU.
struct GpuMesh {
  id<MTLBuffer> vertices = nil, indices = nil, edges = nil;
  uint32_t indexCount = 0, edgeVertices = 0;
};

/// A buffer rewritten every frame. Three copies are kept and used in turn, so the GPU can
/// still be reading the one before last while the next is written.
struct FrameBuffer {
  id<MTLBuffer> copies[3] = {nil, nil, nil};
  /// The copy for frame `frame`, at least `bytes` long (grown, never shrunk).
  id<MTLBuffer> get(id<MTLDevice> device, uint64_t frame, size_t bytes);
};

/// The main pass's targets: lit colour (premultiplied, coverage in alpha), then the two
/// transparency sums. Every pipeline drawn in that pass declares all three. The sums are
/// 32-bit while each layer is rounded to 16 (shaders/brick.metal): a sum of a few such
/// numbers is exact, so it does not depend on the order the layers come in.
inline constexpr MTLPixelFormat kColorFormat = MTLPixelFormatRGBA16Float, kAccumFormat = MTLPixelFormatRGBA32Float, kRevealFormat = MTLPixelFormatR32Float;

struct Pipelines {
  id<MTLRenderPipelineState> brick = nil, transparent = nil, floor = nil, edges = nil, shadow = nil, composite = nil, environment = nil;
  id<MTLDepthStencilState> depthWrite = nil, depthRead = nil, depthNone = nil, shadowDepth = nil;
  id<MTLSamplerState> smooth = nil, shadowSampler = nil;
  bool ok = false;
};
/// Builds every pipeline. `error` receives the first failure's text.
Pipelines makePipelines(Device& device, std::string& error);

/// The two cube maps of the studio's light.
struct Environment {
  id<MTLTexture> reflection = nil, received = nil;
};
Environment makeEnvironment(Device& device, const Pipelines& pipelines);

struct Renderer::Impl {
  Device* device = nullptr;
  const bm::Model* model = nullptr;
  std::unique_ptr<MeshLibrary> meshes;
  Scene scene;
  Pipelines pipelines;
  Environment environment;

  // Per group: its instances on the GPU.
  std::vector<id<MTLBuffer>> instanceBuffers;
  std::vector<bm::Box> meshBounds;  // per group, part space, at full detail
  std::map<std::pair<std::string, int>, GpuMesh> gpuMeshes;  // (part, detail); a placeholder's part is ""
  const GpuMesh& mesh(const Group& group, Detail detail);
  void upload(const std::vector<std::pair<uint32_t, uint32_t>>& changed);

  // Targets, remade when the size changes.
  int width = 0, height = 0;
  id<MTLTexture> colorMs = nil, depthMs = nil, accumMs = nil, revealMs = nil, color = nil, accum = nil, reveal = nil, final = nil, placeholderShadow = nil;
  void makeTargets();
  id<MTLTexture> shadowMap = nil;  // made the first time shadows are drawn

  FrameBuffer frameUniforms, drawUniforms, visible;
  uint64_t frame = 0;
  dispatch_semaphore_t inFlight = nil;
  double gpuMs = 0;
  bool drewOffscreen = false;

  FrameStats draw(const Camera& camera, const FrameOptions& options, id<CAMetalDrawable> drawable);
};

/// Toward the key light (xyz) with its intensity (w), and the studio's four numbers, as the shaders take them.
simd_float4 keyDirectionVector();
simd_float4 roomVector();

inline simd_float4x4 simdFrom(const Mat4& m) {
  simd_float4x4 out;
  for (int c = 0; c < 4; c++) out.columns[c] = simd_make_float4(m.m[c * 4], m.m[c * 4 + 1], m.m[c * 4 + 2], m.m[c * 4 + 3]);
  return out;
}

}  // namespace bmr
