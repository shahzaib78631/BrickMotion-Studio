#include "bmr/render_mesh.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include "bmr/tolerances.h"

namespace bmr {
namespace {
using bm::Vec3;
Vec3 position(const Vertex& v) { return {v.px, v.py, v.pz}; }
Vec3 normal(const Vertex& v) { return {v.nx, v.ny, v.nz}; }
void setNormal(Vertex& v, Vec3 n) {
  n = normalized(n);
  v.nx = static_cast<float>(n.x); v.ny = static_cast<float>(n.y); v.nz = static_cast<float>(n.z);
}
using Point = std::array<int64_t, 3>;
Point key(const Vertex& v) { return {std::llround(v.px * 10000), std::llround(v.py * 10000), std::llround(v.pz * 10000)}; }
struct Edge { size_t triangle; int corner; };
}

// A narrow normal fillet, confined to the original surface. This does not move the
// silhouette, open seams, or change the meshes used by collision/planning.
void roundRenderEdges(RenderMesh& mesh, double width) {
  if (width <= 0 || mesh.empty()) return;
  const size_t count = mesh.indices.size() / 3;
  std::vector<Vec3> faces(count);
  std::map<std::pair<Point, Point>, std::vector<Edge>> edges;
  auto vertex = [&](size_t t, int c) -> const Vertex& { return mesh.vertices[mesh.indices[t * 3 + static_cast<size_t>(c)]]; };
  for (size_t t = 0; t < count; ++t) {
    faces[t] = normalized(cross(position(vertex(t, 1)) - position(vertex(t, 0)), position(vertex(t, 2)) - position(vertex(t, 0))));
    for (int c = 0; c < 3; ++c) {
      Point a = key(vertex(t, c)), b = key(vertex(t, (c + 1) % 3));
      if (b < a) std::swap(a, b);
      edges[{a, b}].push_back({t, c});
    }
  }
  struct Bend { bool sharp = false; Vec3 start, end; };
  std::vector<std::array<Bend, 3>> bends(count);
  const double crease = std::cos(kCreaseDegrees * 3.14159265358979323846 / 180);
  for (const auto& [key0, incidents] : edges) {
    (void)key0;
    if (incidents.size() != 2) continue; // open or non-manifold: preserve the surface
    for (int side = 0; side < 2; ++side) {
      const Edge a = incidents[side], b = incidents[1 - side];
      if (dot(faces[a.triangle], faces[b.triangle]) >= crease) continue;
      const Vertex& start = vertex(a.triangle, a.corner);
      const Vertex& end = vertex(a.triangle, (a.corner + 1) % 3);
      if (start.color != vertex(b.triangle, b.corner).color) continue;
      const Vec3 across = position(vertex(b.triangle, (b.corner + 2) % 3)) - position(start);
      if (dot(faces[a.triangle], across) >= -1e-5) continue; // concave corners stay sharp
      const Vertex& otherStart = key(start) == key(vertex(b.triangle, b.corner)) ? vertex(b.triangle, b.corner) : vertex(b.triangle, (b.corner + 1) % 3);
      const Vertex& otherEnd = key(end) == key(vertex(b.triangle, b.corner)) ? vertex(b.triangle, b.corner) : vertex(b.triangle, (b.corner + 1) % 3);
      bends[a.triangle][a.corner] = {true, normalized(normal(start) + normal(otherStart)), normalized(normal(end) + normal(otherEnd))};
    }
  }
  std::vector<Vertex> vertices;
  std::vector<uint32_t> indices;
  uint32_t top = 0;
  auto emit = [&](Vertex a, Vertex b, Vertex c) {
    if (length(cross(position(b) - position(a), position(c) - position(a))) < 1e-4) return;
    const auto first = static_cast<uint32_t>(vertices.size());
    vertices.insert(vertices.end(), {a, b, c});
    indices.insert(indices.end(), {first, first + 1, first + 2});
  };
  for (size_t t = 0; t < count; ++t) {
    if (t * 3 == mesh.topIndices) top = static_cast<uint32_t>(indices.size());
    std::array<Vertex, 3> outer{vertex(t, 0), vertex(t, 1), vertex(t, 2)}, inner = outer;
    bool rounded = false;
    if (bends[t][0].sharp || bends[t][1].sharp || bends[t][2].sharp) {
      for (double w = width; w >= width / 32; w *= 0.5) {
        bool valid = true;
        for (int c = 0; c < 3; ++c) {
          const int next = (c + 1) % 3, prev = (c + 2) % 3;
          const Vec3 u = position(outer[next]) - position(outer[c]), v = position(outer[prev]) - position(outer[c]);
          const double area = length(cross(u, v));
          if (area < 1e-9) { valid = false; break; }
          // Keep even smooth edges as complete original segments. Putting inner
          // corners exactly on them creates floating-point T-junction cracks.
          const double a = (bends[t][prev].sharp ? w : w * 0.01) * length(v) / area;
          const double b = (bends[t][c].sharp ? w : w * 0.01) * length(u) / area;
          if (a + b >= 0.9) { valid = false; break; }
          const Vec3 p = position(outer[c]) + u * a + v * b;
          inner[c] = outer[c];
          inner[c].px = static_cast<float>(p.x); inner[c].py = static_cast<float>(p.y); inner[c].pz = static_cast<float>(p.z);
          setNormal(inner[c], normal(outer[c]) * (1 - a - b) + normal(outer[next]) * a + normal(outer[prev]) * b);
        }
        if (valid && dot(cross(position(inner[1]) - position(inner[0]), position(inner[2]) - position(inner[0])), faces[t]) > 1e-8) { rounded = true; break; }
      }
    }
    if (!rounded) { emit(outer[0], outer[1], outer[2]); continue; }
    emit(inner[0], inner[1], inner[2]);
    for (int c = 0; c < 3; ++c) {
      const int next = (c + 1) % 3;
      Vertex a = outer[c], b = outer[next];
      if (bends[t][c].sharp) { setNormal(a, bends[t][c].start); setNormal(b, bends[t][c].end); }
      emit(a, b, inner[next]); emit(a, inner[next], inner[c]);
    }
  }
  if (mesh.topIndices == mesh.indices.size()) top = static_cast<uint32_t>(indices.size());
  mesh.vertices = std::move(vertices); mesh.indices = std::move(indices); mesh.topIndices = top;
}
} // namespace bmr
