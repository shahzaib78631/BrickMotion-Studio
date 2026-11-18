// Private to bmrender's Metal half: what the path tracer reads from its scene.
#pragma once
#import <Metal/Metal.h>
#include <string>
#include <unordered_map>
#include <vector>
#include "bmr/path_scene.h"
#include "metal/device.h"

namespace bmr {

/// One part's mesh on the GPU and its acceleration structure.
struct PartStructure {
  id<MTLAccelerationStructure> structure = nil;
  id<MTLBuffer> vertices = nil;  ///< bmr::Vertex
  id<MTLBuffer> indices = nil;   ///< uint32, three a triangle
  uint32_t triangles = 0;
};

struct PathScene::Impl {
  Device* device = nullptr;
  std::vector<PartStructure> structures;                   ///< built ones, in the order first needed
  std::unordered_map<std::string, uint32_t> structureOf;   ///< part name: index, or UINT32_MAX when it has no triangles
  id<MTLAccelerationStructure> instances = nil;            ///< nil when nothing is to be traced
  id<MTLBuffer> instanceDescriptors = nil;
  /// In step with the instance structure's instances: what each one is.
  std::vector<PathInstance> traced;
  std::vector<uint32_t> tracedStructure;  ///< index into `structures`
  PathSceneStats stats;

  /// Builds the structures of these parts, compacted, and waits.
  void buildParts(const std::vector<std::string>& parts, MeshLibrary& meshes);
};

}  // namespace bmr
