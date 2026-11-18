#include "bmr/path_scene.h"

#include <algorithm>
#include <unordered_map>

namespace bmr {

PathInstances pathInstances(const Scene& scene) {
  PathInstances out;
  std::unordered_map<std::string, uint32_t> index;
  for (uint32_t g = 0; g < scene.groups.size(); g++) {
    const Group& group = scene.groups[g];
    const std::string name = group.placeholder ? kPlaceholderPart : group.part;
    auto [at, added] = index.try_emplace(name, static_cast<uint32_t>(out.parts.size()));
    if (added) out.parts.push_back(name);
    for (const Instance& in : group.instances) {
      if (in.flags & kHidden) continue;
      PathInstance p{};
      std::copy(std::begin(in.model), std::end(in.model), std::begin(p.model));
      p.mesh = at->second;
      p.material = g;
      p.mirrored = (in.flags & kMirrored) != 0;
      out.instances.push_back(p);
    }
  }
  return out;
}

std::shared_ptr<const RenderMesh> pathMesh(MeshLibrary& meshes, const std::string& part) {
  if (part == kPlaceholderPart) {
    static const auto box = std::make_shared<const RenderMesh>(boxMesh(bm::kPlaceholderBox));
    return box;
  }
  return meshes.get(part, Detail::Full);
}

}  // namespace bmr
