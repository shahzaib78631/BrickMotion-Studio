#pragma once
#include <array>
#include <vector>
#include "bmr/render_mesh.h"
#include "bmr/scene.h"

namespace bmr {
// Float4 layout shared with glass_transport.metal. Positions are relative to scene.origin.
struct alignas(16) GlassTriangle {
  std::array<float, 4> p[3], n[3], base, surface;
};
struct alignas(16) GlassNode {
  std::array<float, 4> lo, hi;
  std::array<uint32_t, 4> range; // first triangle, count (0 for branch), subtree end, unused
};
struct GlassScene {
  std::vector<GlassTriangle> triangles;
  std::vector<GlassNode> nodes;
};
// Built only for scenes containing glass; includes offscreen objects for reflected/refracted rays.
GlassScene buildGlassScene(const Scene& scene, MeshLibrary& meshes);
}
