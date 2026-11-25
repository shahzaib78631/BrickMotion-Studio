#include "bm/collide/shape.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <mutex>
#include <numeric>
#include <unordered_map>

namespace bm::collide {
namespace {

constexpr uint32_t kLeafSize = 4;

struct Builder {
  const std::vector<Vec3f>& points;
  const std::vector<Vec3f>& inner;  // 3 per triangle, moves with it
  std::vector<uint32_t>& tris;      // 3 per triangle; reordered in place
  std::vector<Node>& nodes;
  std::vector<Vec3f> centroids;     // per triangle, moves with it
  std::vector<Vec3f>& innerMutable;

  void bounds(uint32_t first, uint32_t count, Node& n) const {
    for (int k = 0; k < 3; k++) {
      n.min[k] = n.imin[k] = 1e30f;
      n.max[k] = n.imax[k] = -1e30f;
    }
    auto grow = [](float* lo, float* hi, const Vec3f& p) {
      const float v[3] = {p.x, p.y, p.z};
      for (int k = 0; k < 3; k++) {
        lo[k] = std::min(lo[k], v[k]);
        hi[k] = std::max(hi[k], v[k]);
      }
    };
    for (uint32_t t = first; t < first + count; t++) {
      for (uint32_t c = 0; c < 3; c++) grow(n.min, n.max, points[tris[t * 3 + c]]);
      // An inner triangle with three equal points has no area and crosses nothing: it is in no box.
      const Vec3f &a = inner[t * 3], &b = inner[t * 3 + 1];
      if (a.x == b.x && a.y == b.y && a.z == b.z) continue;
      for (uint32_t c = 0; c < 3; c++) grow(n.imin, n.imax, inner[t * 3 + c]);
    }
  }

  void swapTriangles(uint32_t i, uint32_t j) {
    for (uint32_t c = 0; c < 3; c++) {
      std::swap(tris[i * 3 + c], tris[j * 3 + c]);
      std::swap(innerMutable[i * 3 + c], innerMutable[j * 3 + c]);
    }
    std::swap(centroids[i], centroids[j]);
  }

  void build(uint32_t node, uint32_t first, uint32_t count) {
    bounds(first, count, nodes[node]);
    if (count <= kLeafSize) {
      nodes[node].left = first;
      nodes[node].count = count;
      return;
    }
    // Split at the median centroid along the longest side.
    int axis = 0;
    float best = -1;
    for (int k = 0; k < 3; k++)
      if (nodes[node].max[k] - nodes[node].min[k] > best) {
        best = nodes[node].max[k] - nodes[node].min[k];
        axis = k;
      }
    auto key = [&](uint32_t t) { return axis == 0 ? centroids[t].x : axis == 1 ? centroids[t].y : centroids[t].z; };
    std::vector<float> keys(count);
    for (uint32_t t = 0; t < count; t++) keys[t] = key(first + t);
    std::nth_element(keys.begin(), keys.begin() + count / 2, keys.end());
    const float pivot = keys[count / 2];
    // Partition in place: triangles below the pivot first; ties fill up to the middle.
    uint32_t mid = first;
    for (uint32_t t = first; t < first + count; t++)
      if (key(t) < pivot) swapTriangles(t, mid++);
    for (uint32_t t = mid; t < first + count && mid < first + count / 2; t++)
      if (key(t) == pivot) swapTriangles(t, mid++);
    if (mid == first || mid == first + count) mid = first + count / 2;  // all on one side: split evenly
    const uint32_t left = static_cast<uint32_t>(nodes.size());
    nodes.emplace_back();
    nodes.emplace_back();
    nodes[node].left = left;
    nodes[node].count = 0;
    build(left, first, mid - first);
    build(left + 1, mid, first + count - mid);
  }
};

uint64_t edgeKey(uint32_t a, uint32_t b) { return (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b); }

void buildInnerMetrics(Shape& shape) {
  std::array<std::array<int, 3>, 14> directions{};
  size_t count = 0;
  for (int x = -1; x <= 1; ++x)
    for (int y = -1; y <= 1; ++y)
      for (int z = -1; z <= 1; ++z) {
        const int axes = std::abs(x) + std::abs(y) + std::abs(z);
        if (axes == 1 || axes == 3) directions[count++] = {x, y, z};
      }
  std::array<double, 14> best;
  best.fill(-1e300);
  std::array<Vec3, 14> extrema{};
  for (size_t t = 0; t + 2 < shape.inner.size(); t += 3) {
    const auto& a = shape.inner[t];
    const auto& b = shape.inner[t + 1];
    const bool usable = a.x != b.x || a.y != b.y || a.z != b.z;
    for (size_t corner = 0; corner < 3; ++corner) {
      const auto& v = shape.inner[t + corner];
      shape.innerBounds.grow({v.x, v.y, v.z});
      if (!usable) continue;
      for (size_t d = 0; d < count; ++d) {
        const auto& dir = directions[d];
        const double reach = dir[0] * v.x + dir[1] * v.y + dir[2] * v.z;
        if (reach > best[d]) {
          best[d] = reach;
          extrema[d] = {v.x, v.y, v.z};
        }
      }
    }
  }
  for (size_t d = 0; d < count; ++d) {
    if (best[d] == -1e300) continue;
    const Vec3 point = extrema[d];
    if (std::none_of(shape.innerProbes.begin(), shape.innerProbes.end(), [&](Vec3 have) {
          return length(have - point) < 1e-6;
        })) shape.innerProbes.push_back(point);
  }
}

}  // namespace

Shape buildShape(const ldraw::Mesh& mesh) {
  Shape shape;
  const size_t vertexCount = mesh.positions.size() / 3;
  auto point = [&](uint32_t i) { return Vec3{mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]}; };

  // Keep the triangles that have an area.
  std::vector<Vec3> normals;
  for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
    const uint32_t i = mesh.triangles[t], j = mesh.triangles[t + 1], k = mesh.triangles[t + 2];
    if (i >= vertexCount || j >= vertexCount || k >= vertexCount) continue;
    const Vec3 n = cross(point(j) - point(i), point(k) - point(i));
    const double area = length(n);
    if (!(area > 1e-9)) continue;
    shape.triangles.insert(shape.triangles.end(), {i, j, k});
    normals.push_back(n * (1 / area));
  }
  if (shape.triangles.empty()) return shape;
  const uint32_t count = static_cast<uint32_t>(shape.triangles.size() / 3);

  shape.outer.resize(vertexCount);
  for (uint32_t v = 0; v < vertexCount; v++) {
    const Vec3 p = point(v);
    shape.outer[v] = {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
  }

  // Which triangles share each edge.
  std::unordered_map<uint64_t, std::vector<uint32_t>> edges;
  edges.reserve(count * 3);
  for (uint32_t t = 0; t < count; t++)
    for (uint32_t e = 0; e < 3; e++) edges[edgeKey(shape.triangles[t * 3 + e], shape.triangles[t * 3 + (e + 1) % 3])].push_back(t);

  // How far each edge of each triangle must be trimmed back. Where the surface turns outward
  // across an edge by an angle a (between the two normals), a point a skin below this face
  // is a skin below the neighbouring face too only if it is skin * tan(a / 2) back from the
  // edge: nothing for a flat or inward-turning edge, one skin for a right angle, more for a
  // sharper one. An edge where the surface ends is trimmed by one skin.
  const double kNoInside = 1e6;
  std::vector<float> trim(static_cast<size_t>(count) * 3, 0);
  for (uint32_t t = 0; t < count; t++) {
    const Vec3& n = normals[t];
    for (uint32_t e = 0; e < 3; e++) {
      const uint32_t i = shape.triangles[t * 3 + e], j = shape.triangles[t * 3 + (e + 1) % 3];
      const std::vector<uint32_t>& share = edges[edgeKey(i, j)];
      double amount = share.size() < 2 ? kSkin : 0;
      for (uint32_t other : share) {
        if (other == t) continue;
        const double c = dot(n, normals[other]);
        if (c > 0.99999) continue;  // flat
        // Outward (convex) if the neighbour's far corner lies behind this triangle's plane.
        Vec3 far = point(i);
        for (uint32_t k = 0; k < 3; k++) {
          const uint32_t w = shape.triangles[other * 3 + k];
          if (w != i && w != j) far = point(w);
        }
        if (dot(far - point(i), n) > 1e-6) continue;  // turns inward: the neighbour is no closer
        // Back to back (a sheet with two sides): no distance is enough, the face has no inside.
        amount = std::max(amount, c <= -0.9999 ? kNoInside : kSkin * std::sqrt((1 - c) / (1 + c)));
      }
      trim[t * 3 + e] = static_cast<float>(amount);
    }
  }

  // The triangles around each vertex.
  std::vector<std::vector<uint32_t>> around(vertexCount);
  for (uint32_t t = 0; t < count; t++)
    for (uint32_t c = 0; c < 3; c++) around[shape.triangles[t * 3 + c]].push_back(t);

  // The inner surface. A flat face is usually several triangles; it is trimmed as one face:
  // each corner moves, within the face, until it is far enough from every trimmed edge of the
  // face that meets at that corner. Triangles of one face therefore stay joined.
  shape.inner.resize(static_cast<size_t>(count) * 3);
  struct Limit {
    Vec3 dir;       // into the face, across a trimmed edge
    double amount;  // how far the corner must be from that edge
  };
  std::vector<Limit> limits;  // for one corner
  for (uint32_t t = 0; t < count; t++) {
    const Vec3& n = normals[t];
    Vec3 corner[3];
    bool ok = true;
    for (uint32_t c = 0; c < 3 && ok; c++) {
      const uint32_t v = shape.triangles[t * 3 + c];
      limits.clear();
      for (uint32_t o : around[v]) {
        if (dot(normals[o], n) < 0.9995) continue;  // not part of this flat face
        for (uint32_t e = 0; e < 3; e++) {
          if (trim[o * 3 + e] <= 0) continue;
          const uint32_t i = shape.triangles[o * 3 + e], j = shape.triangles[o * 3 + (e + 1) % 3];
          if (i != v && j != v) continue;
          const Vec3 dir = normalized(cross(n, point(j) - point(i)));
          if (length(dir) > 0.5 && limits.size() < 8) limits.push_back({dir, trim[o * 3 + e]});
        }
      }
      // The smallest move that satisfies every limit (cyclic projection).
      Vec3 move;
      for (int pass = 0; pass < 64; pass++)
        for (const Limit& l : limits) {
          const double lack = l.amount - dot(move, l.dir);
          if (lack > 0) move = move + l.dir * lack;
        }
      for (const Limit& l : limits) ok = ok && dot(move, l.dir) >= l.amount - 1e-3;  // no such move: the face is too thin here
      ok = ok && length(move) < kNoInside / 2;
      corner[c] = point(v) + move - n * kSkin;
    }
    // Trimming must leave a triangle the same way round; otherwise it was too small to keep.
    if (ok) {
      const Vec3 m = cross(corner[1] - corner[0], corner[2] - corner[0]);
      ok = dot(m, n) > 1e-6 && std::isfinite(m.x) && std::isfinite(m.y) && std::isfinite(m.z);
    }
    for (uint32_t c = 0; c < 3; c++) {
      const Vec3 p = ok ? corner[c] : point(shape.triangles[t * 3]) - n * kSkin;  // three equal points: no area, never crosses anything
      shape.inner[t * 3 + c] = {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
    }
  }

  Builder b{shape.outer, shape.inner, shape.triangles, shape.nodes, {}, shape.inner};
  b.centroids.resize(count);
  for (uint32_t t = 0; t < count; t++) {
    const Vec3f& p = shape.outer[shape.triangles[t * 3]];
    const Vec3f& q = shape.outer[shape.triangles[t * 3 + 1]];
    const Vec3f& r = shape.outer[shape.triangles[t * 3 + 2]];
    b.centroids[t] = {(p.x + q.x + r.x) / 3, (p.y + q.y + r.y) / 3, (p.z + q.z + r.z) / 3};
    for (const Vec3f* c : {&p, &q, &r}) shape.bounds.grow({c->x, c->y, c->z});
  }
  shape.nodes.reserve(count);
  shape.nodes.emplace_back();
  b.build(0, 0, count);
  buildInnerMetrics(shape);
  return shape;
}

struct ShapeCache::State {
  struct Entry {
    std::once_flag once;
    std::shared_ptr<const ldraw::Mesh> mesh;  // keeps the key's address from being reused
    std::shared_ptr<const Shape> shape;
  };
  std::mutex mutex;
  std::unordered_map<const ldraw::Mesh*, std::shared_ptr<Entry>> entries;
};

ShapeCache::ShapeCache() : state_(std::make_unique<State>()) {}
ShapeCache::~ShapeCache() = default;

std::shared_ptr<const Shape> ShapeCache::get(const std::shared_ptr<const ldraw::Mesh>& mesh) {
  static const auto empty = std::make_shared<const Shape>();
  if (!mesh) return empty;
  std::shared_ptr<State::Entry> entry;
  {
    std::lock_guard lock(state_->mutex);
    auto& slot = state_->entries[mesh.get()];
    if (!slot) {
      slot = std::make_shared<State::Entry>();
      slot->mesh = mesh;
    }
    entry = slot;
  }
  std::call_once(entry->once, [&] { entry->shape = std::make_shared<const Shape>(buildShape(*mesh)); });
  return entry->shape;
}

}  // namespace bm::collide
