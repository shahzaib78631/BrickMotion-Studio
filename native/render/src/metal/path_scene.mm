#import "metal/path_impl.h"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include "bmr/tolerances.h"

namespace bmr {

namespace {
MTLPrimitiveAccelerationStructureDescriptor* partDescriptor(const PartStructure& part) {
  auto geometry = [MTLAccelerationStructureTriangleGeometryDescriptor descriptor];
  geometry.vertexBuffer = part.vertices;
  geometry.vertexStride = sizeof(Vertex);
  geometry.vertexFormat = MTLAttributeFormatFloat3;
  geometry.indexBuffer = part.indices;
  geometry.indexType = MTLIndexTypeUInt32;
  geometry.triangleCount = part.triangles;
  geometry.opaque = YES;
  auto descriptor = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
  descriptor.geometryDescriptors = @[geometry];
  return descriptor;
}
}  // namespace

std::unique_ptr<PathScene> PathScene::create(std::string* error) {
  auto fail = [&](const char* why) {
    if (error) *error = why;
    return std::unique_ptr<PathScene>();
  };
  Device* device = sharedDevice();
  if (!device) return fail("no Metal device, or its shaders do not compile");
  const char* force = std::getenv("BM_FORCE_NO_RT");
  if (!device->device.supportsRaytracing || (force && std::strcmp(force, "1") == 0)) return fail("this Mac cannot ray-trace from compute");
  auto impl = std::make_unique<Impl>();
  impl->device = device;
  return std::unique_ptr<PathScene>(new PathScene(std::move(impl)));
}

PathScene::PathScene(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
PathScene::~PathScene() = default;
PathSceneStats PathScene::stats() const { return impl_->stats; }

void PathScene::Impl::buildParts(const std::vector<std::string>& parts, MeshLibrary& meshes) {
  std::vector<uint32_t> fresh;
  for (const std::string& name : parts) {
    if (structureOf.count(name)) continue;
    const auto mesh = pathMesh(meshes, name);
    if (!mesh || mesh->indices.size() < 3) {
      structureOf[name] = UINT32_MAX;
      continue;
    }
    PartStructure part;
    part.vertices = [device->device newBufferWithBytes:mesh->vertices.data() length:mesh->vertices.size() * sizeof(Vertex) options:MTLResourceStorageModeShared];
    part.indices = [device->device newBufferWithBytes:mesh->indices.data() length:mesh->indices.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
    part.triangles = static_cast<uint32_t>(mesh->indices.size() / 3);
    structureOf[name] = static_cast<uint32_t>(structures.size());
    fresh.push_back(static_cast<uint32_t>(structures.size()));
    structures.push_back(part);
  }
  if (fresh.empty()) return;
  // Built, then compacted: a part's structure is kept for the whole run.
  std::vector<MTLPrimitiveAccelerationStructureDescriptor*> descriptors;
  id<MTLBuffer> sizes = [device->device newBufferWithLength:fresh.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
  id<MTLCommandBuffer> commands = [device->queue commandBuffer];
  id<MTLAccelerationStructureCommandEncoder> encoder = [commands accelerationStructureCommandEncoder];
  std::vector<id<MTLBuffer>> scratch;
  for (size_t i = 0; i < fresh.size(); i++) {
    PartStructure& part = structures[fresh[i]];
    auto descriptor = partDescriptor(part);
    descriptors.push_back(descriptor);
    const MTLAccelerationStructureSizes need = [device->device accelerationStructureSizesWithDescriptor:descriptor];
    part.structure = [device->device newAccelerationStructureWithSize:need.accelerationStructureSize];
    scratch.push_back([device->device newBufferWithLength:std::max<NSUInteger>(need.buildScratchBufferSize, 16) options:MTLResourceStorageModePrivate]);
    [encoder buildAccelerationStructure:part.structure descriptor:descriptor scratchBuffer:scratch.back() scratchBufferOffset:0];
    [encoder writeCompactedAccelerationStructureSize:part.structure toBuffer:sizes offset:i * sizeof(uint32_t)];
  }
  [encoder endEncoding];
  [commands commit];
  [commands waitUntilCompleted];
  commands = [device->queue commandBuffer];
  encoder = [commands accelerationStructureCommandEncoder];
  const uint32_t* compacted = static_cast<const uint32_t*>(sizes.contents);
  for (size_t i = 0; i < fresh.size(); i++) {
    PartStructure& part = structures[fresh[i]];
    id<MTLAccelerationStructure> small = [device->device newAccelerationStructureWithSize:compacted[i]];
    [encoder copyAndCompactAccelerationStructure:part.structure toAccelerationStructure:small];
    part.structure = small;
  }
  [encoder endEncoding];
  [commands commit];
  [commands waitUntilCompleted];
  stats.partStructuresBuilt += static_cast<uint32_t>(fresh.size());
}

void PathScene::prepare(const Scene& scene, MeshLibrary& meshes) {
  Impl& s = *impl_;
  const PathInstances all = pathInstances(scene);
  s.buildParts(all.parts, meshes);
  const auto start = std::chrono::steady_clock::now();
  s.traced.clear();
  s.tracedStructure.clear();
  for (const PathInstance& in : all.instances) {
    const uint32_t structure = s.structureOf.at(all.parts[in.mesh]);
    if (structure == UINT32_MAX) continue;
    s.traced.push_back(in);
    s.tracedStructure.push_back(structure);
  }
  s.stats.instances = static_cast<uint32_t>(s.traced.size());
  s.origin = scene.origin;
  s.floorY = static_cast<float>((scene.bounds.empty() ? 0.0 : scene.bounds.max.y - scene.origin.y) + kFloorLift);
  std::vector<PtMaterialGpu> materials;
  for (const Group& g : scene.groups) {
    const Material& m = g.material;
    const float kind = g.placeholder ? 2.0f : m.transparent() ? 1.0f : 0.0f;
    materials.push_back({simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha), simd_make_float4(m.roughness, m.metalness, m.clearcoat, kind)});
  }
  s.materialTable = materials.empty() ? nil : [s.device->device newBufferWithBytes:materials.data() length:materials.size() * sizeof(PtMaterialGpu) options:MTLResourceStorageModeShared];
  std::vector<PtMeshGpu> refs;
  for (const PartStructure& p : s.structures) refs.push_back({p.vertices.gpuAddress, p.indices.gpuAddress});
  s.meshTable = refs.empty() ? nil : [s.device->device newBufferWithBytes:refs.data() length:refs.size() * sizeof(PtMeshGpu) options:MTLResourceStorageModeShared];
  std::vector<PtInstanceGpu> table;
  for (size_t i = 0; i < s.traced.size(); i++) {
    const float* m = s.traced[i].model;
    // Columns of the 3x3 part: their cross products are the cofactor's columns, which carry normals.
    const simd_float3 c0 = simd_make_float3(m[0], m[4], m[8]), c1 = simd_make_float3(m[1], m[5], m[9]), c2 = simd_make_float3(m[2], m[6], m[10]);
    const float sign = simd_dot(c0, simd_cross(c1, c2)) < 0 ? -1.0f : 1.0f;
    PtInstanceGpu g{};
    for (int r = 0; r < 3; r++) g.row[r] = simd_make_float4(m[4 * r], m[4 * r + 1], m[4 * r + 2], m[4 * r + 3]);
    g.ncol[0] = simd_make_float4(simd_cross(c1, c2) * sign, 0);
    g.ncol[1] = simd_make_float4(simd_cross(c2, c0) * sign, 0);
    g.ncol[2] = simd_make_float4(simd_cross(c0, c1) * sign, 0);
    g.structure = s.tracedStructure[i];
    g.material = s.traced[i].material;
    table.push_back(g);
  }
  s.instanceTable = table.empty() ? nil : [s.device->device newBufferWithBytes:table.data() length:table.size() * sizeof(PtInstanceGpu) options:MTLResourceStorageModeShared];
  s.instances = nil;
  s.instanceDescriptors = nil;
  if (!s.traced.empty()) {
    s.instanceDescriptors = [s.device->device newBufferWithLength:s.traced.size() * sizeof(MTLAccelerationStructureInstanceDescriptor) options:MTLResourceStorageModeShared];
    auto* out = static_cast<MTLAccelerationStructureInstanceDescriptor*>(s.instanceDescriptors.contents);
    for (size_t i = 0; i < s.traced.size(); i++) {
      const float* m = s.traced[i].model;
      MTLAccelerationStructureInstanceDescriptor d{};
      for (int c = 0; c < 4; c++) d.transformationMatrix.columns[c] = MTLPackedFloat3Make(m[c], m[4 + c], m[8 + c]);
      d.options = MTLAccelerationStructureInstanceOptionOpaque;
      d.mask = 0xFF;
      d.intersectionFunctionTableOffset = 0;
      d.accelerationStructureIndex = s.tracedStructure[i];
      out[i] = d;
    }
    NSMutableArray<id<MTLAccelerationStructure>>* parts = [NSMutableArray arrayWithCapacity:s.structures.size()];
    for (const PartStructure& p : s.structures) [parts addObject:p.structure];
    auto descriptor = [MTLInstanceAccelerationStructureDescriptor descriptor];
    descriptor.instancedAccelerationStructures = parts;
    descriptor.instanceCount = s.traced.size();
    descriptor.instanceDescriptorBuffer = s.instanceDescriptors;
    descriptor.instanceDescriptorType = MTLAccelerationStructureInstanceDescriptorTypeDefault;
    const MTLAccelerationStructureSizes need = [s.device->device accelerationStructureSizesWithDescriptor:descriptor];
    s.instances = [s.device->device newAccelerationStructureWithSize:need.accelerationStructureSize];
    id<MTLBuffer> scratch = [s.device->device newBufferWithLength:std::max<NSUInteger>(need.buildScratchBufferSize, 16) options:MTLResourceStorageModePrivate];
    id<MTLCommandBuffer> commands = [s.device->queue commandBuffer];
    id<MTLAccelerationStructureCommandEncoder> encoder = [commands accelerationStructureCommandEncoder];
    [encoder buildAccelerationStructure:s.instances descriptor:descriptor scratchBuffer:scratch scratchBufferOffset:0];
    [encoder endEncoding];
    [commands commit];
    [commands waitUntilCompleted];
  }
  s.stats.instanceBuildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
}

}  // namespace bmr
