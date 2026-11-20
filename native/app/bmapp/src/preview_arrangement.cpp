#include "preview_arrangement.h"

namespace bmapp {

std::vector<bmr::PiecePose> arrangement(const bm::Model& model, const bmr::Scene& geometry, int step, AssemblyPreview mode) {
  const auto& parts = model.pieces();
  std::vector<bmr::PiecePose> result;
  std::vector<uint32_t> group;
  std::vector<bm::Box> bounds(parts.size());
  result.reserve(parts.size());
  bm::Box installed, current;
  for (uint32_t i = 0; i < parts.size(); ++i) {
    const auto& piece = parts[i];
    const bool picked = step < 0 || piece.step == step;
    const bool show = mode == AssemblyPreview::LaidOut ? picked : step < 0 || piece.step <= step;
    result.push_back({i, piece.world, !show});
    if (!show || i >= geometry.where.size()) continue;
    const auto mesh = geometry.where[i].first;
    if (mesh >= geometry.groups.size()) continue;
    bounds[i] = geometry.groups[mesh].partBox.transformed(piece.world);
    if (bounds[i].empty()) continue;
    if (picked) group.push_back(i), current.merge(bounds[i]);
    else installed.merge(bounds[i]);
  }
  if (group.empty() || mode == AssemblyPreview::Assembled) return result;
  if (mode == AssemblyPreview::Separated) {
    const double dx = installed.empty() ? 0 : installed.max.x - current.min.x + 32;
    for (uint32_t i : group) result[i].world.t.x += dx;
    return result;
  }
  if (mode == AssemblyPreview::Exploded) {
    const auto center = (current.min + current.max) * 0.5;
    for (uint32_t i : group) {
      const auto delta = (bounds[i].min + bounds[i].max) * 0.5 - center;
      result[i].world.t = result[i].world.t + delta * 0.9 + bm::Vec3{0, -22, 0};
    }
    return result;
  }
  constexpr double margin = 8;
  double area = 0, biggest = 0;
  for (uint32_t i : group) {
    const bm::Vec3 size = bounds[i].max - bounds[i].min;
    area += (size.x + margin) * (size.z + margin);
    biggest = std::max(biggest, size.x + margin);
  }
  const double span = std::max(biggest, std::sqrt(area * 1.35));
  const double start = (current.min.x + current.max.x - span) * 0.5;
  double x = 0, z = current.min.z, row = 0;
  for (uint32_t i : group) {
    const auto& box = bounds[i];
    const auto size = box.max - box.min;
    if (x > 0 && x + size.x > span) {
      x = 0;
      z += row + margin;
      row = 0;
    }
    auto& pose = result[i].world;
    pose.t = pose.t + bm::Vec3{start + x - box.min.x, current.max.y - box.max.y, z - box.min.z};
    x += size.x + margin;
    row = std::max(row, size.z);
  }
  return result;
}

}  // namespace bmapp
