#include "bmr/scene.h"

#include <string>

namespace bmr {

bm::Model repeated(const bm::Model& model, bm::ldraw::PartCache& parts, int columns, int rows, double gapLdu) {
  bm::Model::Data data{{}, model.submodels(), model.report(), model.library(), model.inlineParts()};
  const bm::Box b = model.bounds(parts);
  const double stepX = b.empty() ? 0 : b.max.x - b.min.x + gapLdu, stepZ = b.empty() ? 0 : b.max.z - b.min.z + gapLdu;
  if (columns > 0 && rows > 0) data.pieces.reserve(model.pieces().size() * static_cast<size_t>(columns) * static_cast<size_t>(rows));
  int copy = 0;
  for (int row = 0; row < rows; row++)
    for (int column = 0; column < columns; column++, copy++)
      for (const bm::Piece& p : model.pieces()) {
        bm::Piece q = p;
        q.id = "r" + std::to_string(copy) + "/" + p.id;
        q.world.t = q.world.t + bm::Vec3{stepX * column, 0, stepZ * row};
        data.pieces.push_back(std::move(q));
      }
  return bm::Model(std::move(data));
}

}  // namespace bmr
