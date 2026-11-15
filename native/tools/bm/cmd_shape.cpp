#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <filesystem>
#include "bm/collide/shape.h"
#include "bm/ldraw/part_cache.h"
#include "commands.h"

namespace bm::cli {

/// Diagnostic: a part's collision shape, and whether its inner surface really is inside.
int cmdShape(const Args& args) {
  if (args.empty()) {
    std::fprintf(stderr, "usage: bm shape <part>\n");
    return kUsage;
  }
  const std::string ldraw = defaultLDrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bm: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  const ldraw::Library library(ldraw);
  const ldraw::Mesh mesh = ldraw::flatten(args[0], library);
  const collide::Shape shape = collide::buildShape(mesh);
  auto volume = [&](const std::vector<collide::Vec3f>& pts) {
    double v = 0;
    for (size_t t = 0; t + 2 < shape.triangles.size(); t += 3) {
      const auto& a = pts[shape.triangles[t]];
      const auto& b = pts[shape.triangles[t + 1]];
      const auto& c = pts[shape.triangles[t + 2]];
      v += dot(Vec3{a.x, a.y, a.z}, cross(Vec3{b.x, b.y, b.z}, Vec3{c.x, c.y, c.z})) / 6;
    }
    return v;
  };
  Box inner;
  size_t kept = 0;
  for (size_t t = 0; t + 2 < shape.inner.size(); t += 3) {
    const auto& p = shape.inner[t];
    const auto& q = shape.inner[t + 1];
    if (p.x == q.x && p.y == q.y && p.z == q.z) continue;  // trimmed away
    kept++;
    for (size_t k = 0; k < 3; k++) inner.grow({shape.inner[t + k].x, shape.inner[t + k].y, shape.inner[t + k].z});
  }
  // Two-sided triangles: the same three corners in both windings.
  size_t twoSided = 0;
  {
    std::vector<std::array<uint32_t, 3>> keys;
    for (size_t t = 0; t + 2 < shape.triangles.size(); t += 3) {
      std::array<uint32_t, 3> k{shape.triangles[t], shape.triangles[t + 1], shape.triangles[t + 2]};
      std::sort(k.begin(), k.end());
      keys.push_back(k);
    }
    std::sort(keys.begin(), keys.end());
    for (size_t i = 1; i < keys.size(); i++) twoSided += keys[i] == keys[i - 1];
  }
  std::printf("triangles %zu (two-sided %zu), inner triangles kept %zu, vertices %zu\n", shape.triangles.size() / 3, twoSided, kept, shape.outer.size());
  std::printf("outer box  %.2f %.2f %.2f .. %.2f %.2f %.2f   volume %.0f\n", shape.bounds.min.x, shape.bounds.min.y, shape.bounds.min.z, shape.bounds.max.x, shape.bounds.max.y, shape.bounds.max.z, volume(shape.outer));
  if (!inner.empty()) std::printf("inner box  %.2f %.2f %.2f .. %.2f %.2f %.2f\n", inner.min.x, inner.min.y, inner.min.z, inner.max.x, inner.max.y, inner.max.z);
  // --at x y z: the triangles within 1.5 LDU of a point, with their normals and how their
  // corners moved, to see what the surface looks like where a crossing was reported.
  for (size_t i = 0; i + 3 < args.size(); i++) {
    if (args[i] != "--at") continue;
    const Vec3 at{std::atof(std::string(args[i + 1]).c_str()), std::atof(std::string(args[i + 2]).c_str()), std::atof(std::string(args[i + 3]).c_str())};
    int shown = 0;
    for (size_t t = 0; t + 2 < shape.triangles.size() && shown < 14; t += 3) {
      Vec3 o[3], in[3];
      double nearest = 1e9;
      for (int k = 0; k < 3; k++) {
        const auto& p = shape.outer[shape.triangles[t + static_cast<size_t>(k)]];
        const auto& q = shape.inner[t + static_cast<size_t>(k)];
        o[k] = {p.x, p.y, p.z};
        in[k] = {q.x, q.y, q.z};
        nearest = std::min(nearest, length(o[k] - at));
      }
      const Vec3 centre = (o[0] + o[1] + o[2]) * (1.0 / 3);
      const Vec3 n = normalized(cross(o[1] - o[0], o[2] - o[0]));
      // Near a corner or the centre, or lying on a large triangle that passes through the point.
      bool through = std::abs(dot(at - o[0], n)) < 0.3;
      for (int k = 0; k < 3 && through; k++) through = dot(cross(o[(k + 1) % 3] - o[k], at - o[k]), n) >= -1e-6;
      if (std::min(nearest, length(centre - at)) > 1.5 && !through) continue;
      std::printf("  normal (%5.2f %5.2f %5.2f)", n.x, n.y, n.z);
      for (int k = 0; k < 3; k++) std::printf("  (%.1f %.1f %.1f)->moved %.2f along normal", o[k].x, o[k].y, o[k].z, dot(in[k] - o[k], n));
      std::printf("\n");
      shown++;
    }
  }
  return 0;
}

}  // namespace bm::cli
