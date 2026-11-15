#include "bm/model.h"

#include <algorithm>
#include <unordered_map>

namespace bm {

Model::Model(Data data) : data_(std::move(data)) {
  for (const Piece& p : data_.pieces) stepCount_ = std::max(stepCount_, p.step + 1);
}

std::shared_ptr<const ldraw::Mesh> Model::mesh(const std::string& part, ldraw::PartCache& cache) const {
  if (data_.library.isInline(part)) return std::make_shared<const ldraw::Mesh>(ldraw::flatten(part, data_.library));
  return cache.get(part);
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
