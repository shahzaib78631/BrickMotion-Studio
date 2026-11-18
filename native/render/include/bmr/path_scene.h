#pragma once
// What the path tracer traces: one acceleration structure per part mesh, built once a run, and
// one structure of instances (the pieces in the build at a frame), built each frame.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "bmr/render_mesh.h"
#include "bmr/scene.h"

namespace bmr {

/// The mesh name a part with no geometry is traced as: bm::kPlaceholderBox (boxMesh).
inline constexpr const char* kPlaceholderPart = "<placeholder>";

struct PathInstance {
  float model[12];    ///< Instance::model: part space to world less Scene::origin, rows of 3x4
  uint32_t mesh;      ///< index into PathInstances::parts
  uint32_t material;  ///< index into Scene::groups
  bool mirrored;      ///< Instance::flags has kMirrored
};

struct PathInstances {
  /// The distinct meshes, as part names (kPlaceholderPart for a part with no geometry), in the
  /// order Scene::groups first has them, hidden or not: the same list at every frame.
  std::vector<std::string> parts;
  std::vector<PathInstance> instances;  ///< every instance not kHidden, in group order
};

/// Never throws.
PathInstances pathInstances(const Scene& scene);

/// The mesh traced for a name from PathInstances::parts: the Full mesh, or the placeholder box.
std::shared_ptr<const RenderMesh> pathMesh(MeshLibrary& meshes, const std::string& part);

struct PathSceneStats {
  uint32_t partStructuresBuilt = 0;  ///< over the run so far
  uint32_t instances = 0;            ///< in the last prepare
  double instanceBuildMs = 0;        ///< the last prepare's instance structure, built and finished
};

class PathScene {
 public:
  /// Null, with `error` set if given, when there is no Metal device or it cannot ray-trace from
  /// compute kernels. BM_FORCE_NO_RT=1 makes it say so on any machine (tests).
  static std::unique_ptr<PathScene> create(std::string* error);
  ~PathScene();
  PathScene(const PathScene&) = delete;
  PathScene& operator=(const PathScene&) = delete;

  /// Builds the structures of parts not seen before, and the instance structure of `scene` as it
  /// is now. Waits for the GPU. `meshes` must be of the same model at every call.
  void prepare(const Scene& scene, MeshLibrary& meshes);
  PathSceneStats stats() const;

  struct Impl;
  Impl& impl() { return *impl_; }

 private:
  explicit PathScene(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

}  // namespace bmr
