#include "bmr/render_mesh.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <set>
#include <utility>
#include <vector>

namespace bmr {
namespace {

using bm::Vec3;
using Point = std::array<int64_t, 3>;
using Line = std::pair<Point, Point>;

// The LDraw stud primitive has an independent circular base outline; its wall and
// the top of the brick are usually *not* joined by mesh edges. A generic crease
// bevel therefore cannot recognise this joint. Detect the complete, standard
// 12-LDU-diameter outline and check for a supporting top face before touching it.
constexpr double kStudRadius = 6.0;
constexpr double kRadiusTolerance = 0.16;
constexpr double kPlaneTolerance = 0.012;
constexpr double kWallHeight = 4.0;

Vec3 point(const Vertex& v) { return {v.px, v.py, v.pz}; }
Vec3 normal(const Vertex& v) { return {v.nx, v.ny, v.nz}; }
Point quantize(Vec3 p) {
  return {std::llround(p.x * 1000), std::llround(p.y * 1000), std::llround(p.z * 1000)};
}
Line line(Point a, Point b) {
  if (b < a) std::swap(a, b);
  return {a, b};
}
void setNormal(Vertex& v, Vec3 n) {
  n = normalized(n);
  v.nx = static_cast<float>(n.x);
  v.ny = static_cast<float>(n.y);
  v.nz = static_cast<float>(n.z);
}

struct Root {
  double x = 0, y = 0, z = 0;
  std::vector<Point> ring;
  std::vector<Line> outline;
};

// Barycentric test in the horizontal plane; handles either triangle winding.
bool insideDeck(const Vec3& a, const Vec3& b, const Vec3& c, double x, double z) {
  const double det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
  if (std::abs(det) < 1e-7) return false;
  const double u = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / det;
  const double v = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / det;
  return u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001;
}

struct Deck {
  Vec3 a, b, c;
};

bool hasDeck(const Root& root, const std::vector<Deck>& decks) {
  // A genuine stud rises from a flat top surface that continues beyond the
  // circular rim. The top disc of the stud alone must not pass this check.
  constexpr double d = 0.7071067811865476;
  constexpr double directions[8][2] = {{1, 0}, {d, d}, {0, 1}, {-d, d}, {-1, 0}, {-d, -d}, {0, -1}, {d, -d}};
  int supported = 0;
  for (const auto& dir : directions) {
    const double x = root.x + (kStudRadius + 0.65) * dir[0];
    const double z = root.z + (kStudRadius + 0.65) * dir[1];
    for (const Deck& deck : decks) {
      if (std::abs(deck.a.y - root.y) < kPlaneTolerance && insideDeck(deck.a, deck.b, deck.c, x, z)) {
        ++supported;
        break;
      }
    }
  }
  return supported >= 6;
}

std::vector<Root> findRoots(const RenderMesh& mesh) {
  using Neighbors = std::map<Point, std::vector<Point>>;
  Neighbors adjacency;
  // Six floats are a line's two endpoints. Quantising here also tolerates the
  // small rounding differences introduced by LDraw subpart transforms.
  for (size_t i = 0; i + 5 < mesh.edges.size(); i += 6) {
    const Vec3 a{mesh.edges[i], mesh.edges[i + 1], mesh.edges[i + 2]};
    const Vec3 b{mesh.edges[i + 3], mesh.edges[i + 4], mesh.edges[i + 5]};
    if (std::abs(a.y - b.y) > kPlaneTolerance) continue;
    const Point ka = quantize(a), kb = quantize(b);
    if (ka == kb) continue;
    adjacency[ka].push_back(kb);
    adjacency[kb].push_back(ka);
  }
  if (adjacency.empty()) return {};

  std::vector<Deck> decks;
  decks.reserve(mesh.indices.size() / 12);
  for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
    const Vec3 a = point(mesh.vertices[mesh.indices[t]]);
    const Vec3 b = point(mesh.vertices[mesh.indices[t + 1]]);
    const Vec3 c = point(mesh.vertices[mesh.indices[t + 2]]);
    const Vec3 n = cross(b - a, c - a);
    if (n.y < -0.97 * length(n) &&
        std::abs(a.y - b.y) < kPlaneTolerance && std::abs(a.y - c.y) < kPlaneTolerance)
      decks.push_back({a, b, c});
  }
  if (decks.empty()) return {};

  std::set<Point> visited;
  std::vector<Root> roots;
  for (const auto& item : adjacency) {
    if (!visited.insert(item.first).second) continue;
    std::vector<Point> stack{item.first};
    Root r;
    bool closed = true;
    while (!stack.empty()) {
      const Point a = stack.back();
      stack.pop_back();
      r.ring.push_back(a);
      const auto& neighbors = adjacency.at(a);
      if (neighbors.size() != 2) closed = false;
      for (const Point& b : neighbors) {
        if (a < b) r.outline.push_back(line(a, b));
        if (visited.insert(b).second) stack.push_back(b);
      }
    }
    if (!closed || r.ring.size() < 12 || r.ring.size() > 256) continue;
    for (const Point& p : r.ring) {
      r.x += double(p[0]) / 1000;
      r.y += double(p[1]) / 1000;
      r.z += double(p[2]) / 1000;
    }
    r.x /= r.ring.size(); r.y /= r.ring.size(); r.z /= r.ring.size();
    bool circular = true;
    for (const Point& p : r.ring) {
      const double x = double(p[0]) / 1000 - r.x;
      const double y = double(p[1]) / 1000 - r.y;
      const double z = double(p[2]) / 1000 - r.z;
      if (std::abs(y) > kPlaneTolerance || std::abs(std::hypot(x, z) - kStudRadius) > kRadiusTolerance) {
        circular = false;
        break;
      }
    }
    if (!circular || !hasDeck(r, decks)) continue;
    roots.push_back(std::move(r));
  }
  return roots;
}

// A stud wall is nearly vertical, cylindrical and outward-facing. Reject hole
// interiors, slopes, and the horizontal brick/stud faces sharing ring vertices.
bool wallTriangle(const std::array<Vertex, 3>& v, const Root& root) {
  const Vec3 a = point(v[0]), b = point(v[1]), c = point(v[2]);
  const Vec3 n = cross(b - a, c - a);
  const Vec3 mid = (a + b + c) * (1.0 / 3.0);
  const Vec3 radial{mid.x - root.x, 0, mid.z - root.z};
  if (length(n) < 1e-8 || length(radial) < 1e-6 || dot(normalized(n), normalized(radial)) < 0.80) return false;
  for (const Vec3& p : {a, b, c}) {
    if (std::abs(std::hypot(p.x - root.x, p.z - root.z) - kStudRadius) > kRadiusTolerance ||
        p.y > root.y + kPlaneTolerance || p.y < root.y - (kWallHeight + 0.1)) return false;
  }
  return true;
}

Vertex intersect(Vertex a, Vertex b, float y) {
  // Always traverse an edge in the same order, so adjacent triangles obtain
  // bit-identical intersection positions rather than tiny T-junction cracks.
  if (quantize(point(b)) < quantize(point(a))) std::swap(a, b);
  const float t = (y - a.py) / (b.py - a.py);
  Vertex out = a;
  out.px += (b.px - a.px) * t;
  out.py = y;
  out.pz += (b.pz - a.pz) * t;
  setNormal(out, normal(a) * (1.0 - t) + normal(b) * t);
  return out;
}

struct Polygon {
  std::array<Vertex, 4> vertices{};
  size_t count = 0;
};

Polygon clip(const std::array<Vertex, 3>& triangle, float y, bool towardBase) {
  Polygon result;
  for (int i = 0; i < 3; ++i) {
    const Vertex& a = triangle[i];
    const Vertex& b = triangle[(i + 1) % 3];
    const bool ina = towardBase ? a.py >= y : a.py <= y;
    const bool inb = towardBase ? b.py >= y : b.py <= y;
    if (ina) result.vertices[result.count++] = a;
    if (ina != inb) result.vertices[result.count++] = intersect(a, b, y);
  }
  return result;
}

void emit(RenderMesh& mesh, std::vector<uint32_t>& indices, const Polygon& polygon,
          const Root* root, double width) {
  if (polygon.count < 3) return;
  std::array<Vertex, 4> vertices = polygon.vertices;
  if (root) {
    for (size_t j = 0; j < polygon.count; ++j) {
      Vertex& v = vertices[j];
      const double t = std::clamp((root->y - v.py) / width, 0.0, 1.0);
      const double s = t * t * (3.0 - 2.0 * t);
      setNormal(v, Vec3{0, -1, 0} * (1.0 - s) + normal(v) * s);
    }
  }
  const uint32_t start = static_cast<uint32_t>(mesh.vertices.size());
  for (size_t j = 0; j < polygon.count; ++j) mesh.vertices.push_back(vertices[j]);
  for (size_t j = 1; j + 1 < polygon.count; ++j) {
    const Vec3 a = point(vertices[0]), b = point(vertices[j]), c = point(vertices[j + 1]);
    if (length(cross(b - a, c - a)) > 1e-8) {
      indices.push_back(start);
      indices.push_back(start + static_cast<uint32_t>(j));
      indices.push_back(start + static_cast<uint32_t>(j + 1));
    }
  }
}

}  // namespace

void softenStudRoots(RenderMesh& mesh, double width) {
  if (mesh.empty() || mesh.edges.empty() || !(width > 0)) return;
  const std::vector<Root> found = findRoots(mesh);
  if (found.empty()) return;

  // O(log n) association per triangle rather than scanning every stud on a
  // large plate. The expensive root discovery happens only once per cached mesh.
  std::map<Point, size_t> atRoot;
  for (size_t i = 0; i < found.size(); ++i)
    for (const Point& p : found[i].ring) atRoot.emplace(p, i);

  const size_t triangles = mesh.indices.size() / 3;
  std::vector<int> qualifying(found.size(), 0);
  std::vector<int> rootForTriangle(triangles, -1);
  for (size_t t = 0; t < triangles; ++t) {
    const std::array<Vertex, 3> tri = {mesh.vertices[mesh.indices[3 * t]], mesh.vertices[mesh.indices[3 * t + 1]], mesh.vertices[mesh.indices[3 * t + 2]]};
    for (const Vertex& v : tri) {
      auto it = atRoot.find(quantize(point(v)));
      if (it != atRoot.end() && wallTriangle(tri, found[it->second])) {
        rootForTriangle[t] = static_cast<int>(it->second);
        ++qualifying[it->second];
        break;
      }
    }
  }
  std::vector<bool> valid(found.size(), false);
  bool any = false;
  for (size_t i = 0; i < found.size(); ++i) {
    valid[i] = qualifying[i] >= 8;
    any |= valid[i];
  }
  if (!any) return;

  // Remove only the confirmed stud *base* ring, keeping the sharp top rim,
  // silhouette edges, and all ordinary LDraw lines. Those base lines are what
  // otherwise draws a crisp dark circle across the smooth shaded transition.
  std::set<Line> suppressed;
  for (size_t i = 0; i < found.size(); ++i)
    if (valid[i]) suppressed.insert(found[i].outline.begin(), found[i].outline.end());
  std::vector<float> edges;
  edges.reserve(mesh.edges.size());
  for (size_t i = 0; i + 5 < mesh.edges.size(); i += 6) {
    const Point a = quantize(Vec3{mesh.edges[i], mesh.edges[i + 1], mesh.edges[i + 2]});
    const Point b = quantize(Vec3{mesh.edges[i + 3], mesh.edges[i + 4], mesh.edges[i + 5]});
    if (suppressed.count(line(a, b)) == 0)
      edges.insert(edges.end(), mesh.edges.begin() + static_cast<ptrdiff_t>(i), mesh.edges.begin() + static_cast<ptrdiff_t>(i + 6));
  }
  mesh.edges = std::move(edges);

  size_t modified = 0;
  for (size_t i = 0; i < found.size(); ++i)
    if (valid[i]) modified += static_cast<size_t>(qualifying[i]);
  const size_t oldTop = mesh.topIndices / 3;
  const std::vector<uint32_t> oldIndices = std::move(mesh.indices);
  std::vector<uint32_t> indices;
  indices.reserve(oldIndices.size() + modified * 6);
  mesh.vertices.reserve(mesh.vertices.size() + modified * 7);
  uint32_t top = 0;
  for (size_t t = 0; t < triangles; ++t) {
    if (t == oldTop) top = static_cast<uint32_t>(indices.size());
    const int r = rootForTriangle[t];
    if (r < 0 || !valid[r]) {
      indices.insert(indices.end(), oldIndices.begin() + static_cast<ptrdiff_t>(3 * t), oldIndices.begin() + static_cast<ptrdiff_t>(3 * t + 3));
      continue;
    }
    const std::array<Vertex, 3> tri = {mesh.vertices[oldIndices[3 * t]], mesh.vertices[oldIndices[3 * t + 1]], mesh.vertices[oldIndices[3 * t + 2]]};
    const float cut = static_cast<float>(found[r].y - width);
    emit(mesh, indices, clip(tri, cut, false), nullptr, width);
    emit(mesh, indices, clip(tri, cut, true), &found[r], width);
  }
  if (oldTop == triangles) top = static_cast<uint32_t>(indices.size());
  mesh.indices = std::move(indices);
  mesh.topIndices = top;
}

}  // namespace bmr
