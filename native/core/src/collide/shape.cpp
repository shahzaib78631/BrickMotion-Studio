#include "bm/collide/shape.h"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <numeric>
#include <unordered_map>

namespace bm::collide {
namespace {

constexpr uint32_t kLeafSize = 4;
constexpr double kSameFace = 0.95;    // normals closer than this (cosine) belong to one face
constexpr size_t kMaxFacesAtVertex = 8;

struct Builder {
  const std::vector<Vec3f>& points;
  const std::vector<Vec3f>& inner;
  std::vector<uint32_t>& tris;  // 3 per triangle; reordered in place
  std::vector<Node>& nodes;
  std::vector<Vec3f> centroids;  // per triangle, moves with it

  void bounds(uint32_t first, uint32_t count, Node& n) const {
    for (int k = 0; k < 3; k++) {
      n.min[k] = 1e30f;
      n.max[k] = -1e30f;
    }
    for (uint32_t t = first; t < first + count; t++)
      for (uint32_t c = 0; c < 3; c++)
        for (const Vec3f* p : {&points[tris[t * 3 + c]], &inner[tris[t * 3 + c]]}) {
          const float v[3] = {p->x, p->y, p->z};
          for (int k = 0; k < 3; k++) {
            n.min[k] = std::min(n.min[k], v[k]);
            n.max[k] = std::max(n.max[k], v[k]);
          }
        }
  }

  void swapTriangles(uint32_t i, uint32_t j) {
    for (uint32_t c = 0; c < 3; c++) std::swap(tris[i * 3 + c], tris[j * 3 + c]);
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
    std::vector<uint32_t> order(count);
    std::iota(order.begin(), order.end(), first);
    std::nth_element(order.begin(), order.begin() + count / 2, order.end(), [&](uint32_t x, uint32_t y) { return key(x) < key(y); });
    const float pivot = key(order[count / 2]);
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

}  // namespace

Shape buildShape(const ldraw::Mesh& mesh) {
  Shape shape;
  const size_t vertexCount = mesh.positions.size() / 3;
  auto point = [&](uint32_t i) { return Vec3{mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]}; };

  // Keep the triangles that have an area, and note each one's normal at its three corners.
  std::vector<std::vector<Vec3>> faces(vertexCount);  // distinct face normals meeting at each vertex
  for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
    const uint32_t i = mesh.triangles[t], j = mesh.triangles[t + 1], k = mesh.triangles[t + 2];
    if (i >= vertexCount || j >= vertexCount || k >= vertexCount) continue;
    const Vec3 n = cross(point(j) - point(i), point(k) - point(i));
    const double area = length(n);
    if (!(area > 1e-9)) continue;
    const Vec3 unit = n * (1 / area);
    shape.triangles.insert(shape.triangles.end(), {i, j, k});
    for (uint32_t v : {i, j, k}) {
      std::vector<Vec3>& list = faces[v];
      const bool known = std::any_of(list.begin(), list.end(), [&](const Vec3& f) { return dot(f, unit) > kSameFace; });
      if (!known && list.size() < kMaxFacesAtVertex) list.push_back(unit);
    }
  }
  if (shape.triangles.empty()) return shape;

  // Move each vertex against the faces that meet there. For faces at right angles this moves
  // each of them in by exactly the skin.
  shape.outer.resize(vertexCount);
  shape.inner.resize(vertexCount);
  for (uint32_t v = 0; v < vertexCount; v++) {
    Vec3 sum;
    for (const Vec3& f : faces[v]) sum = sum + f;
    Vec3 move;
    if (length(sum) > 0.3) {  // otherwise the faces cancel: two-sided geometry, left where it is
      move = sum * -kSkin;
      if (length(move) > 2 * kSkin) move = move * (2 * kSkin / length(move));
    }
    const Vec3 p = point(v), q = p + move;
    shape.outer[v] = {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
    shape.inner[v] = {static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)};
  }

  const uint32_t count = static_cast<uint32_t>(shape.triangles.size() / 3);
  Builder b{shape.outer, shape.inner, shape.triangles, shape.nodes, {}};
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
