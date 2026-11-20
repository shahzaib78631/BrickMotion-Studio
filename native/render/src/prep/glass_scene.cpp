#include "bmr/glass_scene.h"
#include <algorithm>
#include <numeric>
#include <map>
#include <cmath>

namespace bmr {
namespace {
using bm::Vec3;
std::array<float, 4> f4(Vec3 v) { return {static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z), 0}; }
Vec3 point(const std::array<float, 4>& p) { return {p[0], p[1], p[2]}; }
uint32_t split(GlassScene& out, size_t first, size_t end) {
  const auto node = static_cast<uint32_t>(out.nodes.size());
  out.nodes.emplace_back();
  bm::Box bounds, centers;
  auto center = [](const GlassTriangle& t) { return (point(t.p[0]) + point(t.p[1]) + point(t.p[2])) * (1.0 / 3); };
  for (size_t i = first; i < end; ++i) {
    for (const auto& p : out.triangles[i].p) bounds.grow(point(p));
    centers.grow(center(out.triangles[i]));
  }
  if (end - first > 8) {
    const Vec3 size = centers.max - centers.min;
    const int axis = size.x > size.y && size.x > size.z ? 0 : size.y > size.z ? 1 : 2;
    auto component = [axis](Vec3 v) { return axis == 0 ? v.x : axis == 1 ? v.y : v.z; };
    const size_t middle = first + (end - first) / 2;
    std::nth_element(out.triangles.begin() + static_cast<ptrdiff_t>(first), out.triangles.begin() + static_cast<ptrdiff_t>(middle), out.triangles.begin() + static_cast<ptrdiff_t>(end),
      [&](const GlassTriangle& a, const GlassTriangle& b) { return component(center(a)) < component(center(b)); });
    split(out, first, middle); split(out, middle, end);
  }
  out.nodes[node] = {f4(bounds.min - Vec3{.001, .001, .001}), f4(bounds.max + Vec3{.001, .001, .001}),
    {static_cast<uint32_t>(first), end - first <= 8 ? static_cast<uint32_t>(end - first) : 0, static_cast<uint32_t>(out.nodes.size()), 0}};
  return node;
}
}
GlassScene buildGlassScene(const Scene& scene, MeshLibrary& meshes) {
  GlassScene out;
  for (const auto& group : scene.groups) {
    if (group.placeholder) continue;
    const auto mesh = meshes.get(group.part, Detail::Full);
    for (const Instance& in : group.instances) {
      if (in.flags & kNotShown) continue;
      const float* m = in.model;
      const Vec3 c0{m[0], m[4], m[8]}, c1{m[1], m[5], m[9]}, c2{m[2], m[6], m[10]};
      const double det = dot(c0, cross(c1, c2));
      if (std::abs(det) < 1e-12) continue;
      for (size_t i = 0; i < mesh->indices.size(); i += 3) {
        GlassTriangle t{};
        for (int j = 0; j < 3; ++j) {
          const Vertex& v = mesh->vertices[mesh->indices[i + static_cast<size_t>(j)]];
          t.p[j] = f4(c0 * v.px + c1 * v.py + c2 * v.pz + Vec3{m[3], m[7], m[11]});
          t.n[j] = f4(normalized((cross(c1, c2) * v.nx + cross(c2, c0) * v.ny + cross(c0, c1) * v.nz) * (1 / det)));
          if (j == 0) {
            t.base = {group.material.base[0], group.material.base[1], group.material.base[2], group.material.transparent() ? 1.0f : 0.0f};
            if (v.color) t.base = {linearFromSrgb((v.color >> 16) & 255), linearFromSrgb((v.color >> 8) & 255), linearFromSrgb(v.color & 255), t.base[3]};
          }
        }
        t.n[0][3] = static_cast<float>(in.piece);
        // Keep the geometric winding outward after mirrored placements.
        if (det < 0) { std::swap(t.p[1], t.p[2]); std::swap(t.n[1], t.n[2]); }
        t.surface = {group.material.roughness, group.material.metalness, group.material.clearcoat, 0};
        out.triangles.push_back(t);
      }
    }
  }
  // Mark coincident planes belonging to multiple pieces using a flat sorted key list.
  // Metal may choose either primitive at an exact tie; those hits use the narrow CPU-BVH traversal.
  struct PlaneEntry {
    std::array<int64_t, 4> key;
    uint32_t piece;
    uint32_t tri;
    bm::Box bounds;
  };
  std::vector<PlaneEntry> entries;
  entries.reserve(out.triangles.size());
  auto plane = [](const GlassTriangle& t) {
    Vec3 n = normalized(cross(point(t.p[1]) - point(t.p[0]), point(t.p[2]) - point(t.p[0])));
    if (n.x < -1e-5 || (std::abs(n.x) < 1e-5 && n.y < -1e-5) || (std::abs(n.x) < 1e-5 && std::abs(n.y) < 1e-5 && n.z < 0)) n = n * -1;
    return std::array<int64_t, 4>{std::llround(n.x * 10000), std::llround(n.y * 10000), std::llround(n.z * 10000), std::llround(dot(n, point(t.p[0])) * 1000)};
  };
  for (uint32_t idx = 0; idx < out.triangles.size(); ++idx) {
    const auto& t = out.triangles[idx];
    bm::Box b;
    for (const auto& p : t.p) b.grow(point(p));
    entries.push_back({plane(t), static_cast<uint32_t>(t.n[0][3]), idx, b});
  }
  std::sort(entries.begin(), entries.end(), [](const PlaneEntry& a, const PlaneEntry& b) {
    if (a.key != b.key) return a.key < b.key;
    return a.piece < b.piece;
  });
  for (size_t i = 0; i < entries.size();) {
    size_t j = i + 1;
    while (j < entries.size() && entries[j].key == entries[i].key) ++j;
    // Fast skip when all triangles on this plane belong to a single piece.
    if (entries[i].piece != entries[j - 1].piece) {
      // Merge per-piece bounds on this plane.
      std::vector<std::pair<uint32_t, bm::Box>> byPiece;
      for (size_t k = i; k < j;) {
        bm::Box merged = entries[k].bounds;
        const uint32_t piece = entries[k].piece;
        ++k;
        while (k < j && entries[k].piece == piece) { merged.merge(entries[k].bounds); ++k; }
        byPiece.push_back({piece, merged});
      }
      for (size_t k = i; k < j; ++k) {
        const bm::Box& bounds = entries[k].bounds;
        for (const auto& [piece, other] : byPiece) {
          if (piece == entries[k].piece) continue;
          const double x = std::min(bounds.max.x, other.max.x) - std::max(bounds.min.x, other.min.x);
          const double y = std::min(bounds.max.y, other.max.y) - std::max(bounds.min.y, other.min.y);
          const double z = std::min(bounds.max.z, other.max.z) - std::max(bounds.min.z, other.min.z);
          if (x >= -0.001 && y >= -0.001 && z >= -0.001 && int(x > 0.001) + int(y > 0.001) + int(z > 0.001) >= 2) {
            out.triangles[entries[k].tri].surface[3] = 1;
            break;
          }
        }
      }
    }
    i = j;
  }
  // Canonical input makes coincident intersections independent of instance listing order.
  std::sort(out.triangles.begin(), out.triangles.end(), [](const GlassTriangle& a, const GlassTriangle& b) {
    for (int i = 0; i < 3; ++i) if (a.p[i] != b.p[i]) return a.p[i] < b.p[i];
    if (a.base != b.base) return a.base < b.base;
    for (int i = 0; i < 3; ++i) if (a.n[i] != b.n[i]) return a.n[i] < b.n[i];
    return a.surface < b.surface;
  });
  if (!out.triangles.empty()) split(out, 0, out.triangles.size());
  return out;
}
}
