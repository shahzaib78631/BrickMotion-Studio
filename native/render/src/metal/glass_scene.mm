#import "metal/impl.h"
#import "metal/path_impl.h"
#include "bmr/glass_scene.h"

namespace bmr {
void Renderer::Impl::prepareGlass() {
  if (device->device.supportsRaytracing && pipelines.glassCompute) {
    if (glassRevision == lastChange && rtScene && rtScene->impl().instances) return;
    if (!rtScene) rtScene = PathScene::create(nullptr);
    if (rtScene) {
      rtScene->prepare(scene, *meshes);
      glassRevision = lastChange;
      return;
    }
  }
  if (glassRevision == lastChange && glassNodes) return;
  const auto data = buildGlassScene(scene, *meshes);
  glassNodeCount = static_cast<uint32_t>(data.nodes.size());
  // New immutable buffers: in-flight frames retain their previous snapshot.
  glassNodes = data.nodes.empty() ? nil : [device->device newBufferWithBytes:data.nodes.data() length:data.nodes.size() * sizeof(GlassNode) options:MTLResourceStorageModeShared];
  glassTriangles = data.triangles.empty() ? nil : [device->device newBufferWithBytes:data.triangles.data() length:data.triangles.size() * sizeof(GlassTriangle) options:MTLResourceStorageModeShared];
  glassAcceleration = nil;
  if (device->device.supportsRaytracingFromRender && !data.triangles.empty()) {
    std::vector<std::array<float, 4>> positions;
    positions.reserve(data.triangles.size() * 3);
    for (const auto& triangle : data.triangles) for (const auto& p : triangle.p) positions.push_back(p);
    auto geometry = [MTLAccelerationStructureTriangleGeometryDescriptor descriptor];
    geometry.vertexBuffer = [device->device newBufferWithBytes:positions.data() length:positions.size() * sizeof(positions[0]) options:MTLResourceStorageModeShared];
    geometry.vertexStride = sizeof(positions[0]);
    geometry.triangleCount = data.triangles.size();
    geometry.opaque = YES;
    auto descriptor = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
    descriptor.geometryDescriptors = @[geometry];
    const auto sizes = [device->device accelerationStructureSizesWithDescriptor:descriptor];
    glassAcceleration = [device->device newAccelerationStructureWithSize:sizes.accelerationStructureSize];
    auto scratch = [device->device newBufferWithLength:sizes.buildScratchBufferSize options:MTLResourceStorageModePrivate];
    auto commands = [device->queue commandBuffer];
    auto encoder = [commands accelerationStructureCommandEncoder];
    [encoder buildAccelerationStructure:glassAcceleration descriptor:descriptor scratchBuffer:scratch scratchBufferOffset:0];
    [encoder endEncoding];
    [commands commit]; // same queue as the subsequent frame: no blocking CPU wait
  }
  glassRevision = lastChange;
}
}
