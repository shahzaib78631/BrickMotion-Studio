#include "bm/model.h"

#include <algorithm>
#include <mutex>
#include <unordered_map>

namespace bm {

struct Model::InlineMeshCache {
  struct Entry {
    std::once_flag once;
    std::shared_ptr<const ldraw::Mesh> mesh;
  };
  std::mutex mutex;
  std::unordered_map<std::string, std::shared_ptr<Entry>> parts;
};

Model::Model(Data data) : data_(std::move(data)), inlineMeshes_(std::make_shared<InlineMeshCache>()) {
  for (const Piece& p : data_.pieces) stepCount_ = std::max(stepCount_, p.step + 1);
}

std::shared_ptr<const ldraw::Mesh> Model::mesh(const std::string& part, ldraw::PartCache& cache) const {
  const std::string key = ldraw::normalizeName(part);
  if (!data_.library.isInline(key)) return cache.get(part);
  // An inline part belongs to this model, not the global part cache. Rebuilding it
  // for every World/Contact/Certificate used to create a fresh ShapeCache key too.
  // Copies of this immutable model share the cache, and different parts may flatten
  // concurrently while call_once prevents duplicate work for the same part.
  std::shared_ptr<InlineMeshCache::Entry> entry;
  {
    std::lock_guard lock(inlineMeshes_->mutex);
    auto& slot = inlineMeshes_->parts[key];
    if (!slot) slot = std::make_shared<InlineMeshCache::Entry>();
    entry = slot;
  }
  std::call_once(entry->once, [&] {
    entry->mesh = std::make_shared<const ldraw::Mesh>(ldraw::flatten(key, data_.library));
  });
  return entry->mesh;
}

Box Model::bounds(ldraw::PartCache& cache) const {
  Box out;
  std::unordered_map<std::string, Box> boxes;  // one lookup per distinct part
  for (const Piece& p : data_.pieces) {
    auto it = boxes.find(p.part);
    if (it == boxes.end()) {
      const Box b = mesh(p.part, cache)->bounds;
      it = boxes.emplace(p.part, b.empty() ? kPlaceholderBox : b).first;
    }
    out.merge(it->second.transformed(p.world));
  }
  return out;
}

}  // namespace bm
