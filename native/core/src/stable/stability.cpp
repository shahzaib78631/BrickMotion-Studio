#include "bm/stable/stability.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <numeric>
#include <unordered_map>
#include "bm/stable/tolerances.h"

namespace bm::stable {
namespace {

struct Point2 {
  double x = 0, y = 0;
};
double turn(Point2 o, Point2 a, Point2 b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

/// The convex hull, counter-clockwise, without repeated or collinear points.
std::vector<Point2> hull(std::vector<Point2> p) {
  std::sort(p.begin(), p.end(), [](Point2 a, Point2 b) { return a.x < b.x || (a.x == b.x && a.y < b.y); });
  p.erase(std::unique(p.begin(), p.end(), [](Point2 a, Point2 b) { return a.x == b.x && a.y == b.y; }), p.end());
  if (p.size() < 3) return p;
  std::vector<Point2> h(2 * p.size());
  size_t k = 0;
  for (size_t i = 0; i < p.size(); i++) {
    while (k >= 2 && turn(h[k - 2], h[k - 1], p[i]) <= 0) k--;
    h[k++] = p[i];
  }
  for (size_t i = p.size() - 1, lower = k + 1; i-- > 0;) {
    while (k >= lower && turn(h[k - 2], h[k - 1], p[i]) <= 0) k--;
    h[k++] = p[i];
  }
  h.resize(k - 1);
  return h;
}

double toSegment(Point2 p, Point2 a, Point2 b) {
  const double dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const double t = len2 > 0 ? std::clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0.0, 1.0) : 0;
  return std::hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/// Distance from `p` to the hull's edge: positive inside, negative outside. A hull with no
/// area has no inside.
double marginOf(Point2 p, const std::vector<Point2>& h) {
  if (h.empty()) return -std::numeric_limits<double>::infinity();
  if (h.size() == 1) return -std::hypot(p.x - h[0].x, p.y - h[0].y);
  if (h.size() == 2) return -toSegment(p, h[0], h[1]);
  bool inside = true;
  double nearest = std::numeric_limits<double>::infinity();
  for (size_t i = 0; i < h.size(); i++) {
    const Point2 a = h[i], b = h[(i + 1) % h.size()];
    if (turn(a, b, p) < 0) inside = false;
    nearest = std::min(nearest, toSegment(p, a, b));
  }
  return inside ? nearest : -nearest;
}

struct UnionFind {
  std::vector<uint32_t> parent;
  explicit UnionFind(uint32_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0u); }
  uint32_t find(uint32_t x) {
    while (parent[x] != x) x = parent[x] = parent[parent[x]];
    return x;
  }
  void join(uint32_t a, uint32_t b) { parent[find(a)] = find(b); }
};

}  // namespace

double massOf(const ldraw::Mesh& mesh, Vec3* centre) {
  const Box& box = mesh.bounds;
  if (box.empty()) {
    if (centre) *centre = {};
    return 0;
  }
  const Vec3 size = box.max - box.min, middle = (box.min + box.max) * 0.5;
  const double boxVolume = size.x * size.y * size.z;
  // Signed volume of the tetrahedra from the box's middle to each triangle, and their centroid.
  double volume = 0;
  Vec3 moment{};
  auto point = [&](uint32_t i) { return Vec3{mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]} - middle; };
  for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
    const Vec3 a = point(mesh.triangles[t]), b = point(mesh.triangles[t + 1]), c = point(mesh.triangles[t + 2]);
    const double v = dot(a, cross(b, c)) / 6;
    volume += v;
    moment = moment + (a + b + c) * (v / 4);
  }
  // LDraw's y points down, which makes a mesh wound counter-clockwise from outside enclose a
  // negative volume in these coordinates; either sign is taken.
  const double enclosed = std::abs(volume);
  if (boxVolume > 0 && enclosed >= kMinFill * boxVolume && enclosed <= boxVolume) {
    if (centre) {
      const Vec3 c = middle + moment * (1 / volume);
      const bool inBox = c.x >= box.min.x && c.x <= box.max.x && c.y >= box.min.y && c.y <= box.max.y && c.z >= box.min.z && c.z <= box.max.z;
      *centre = inBox ? c : middle;
    }
    return enclosed * kDensity;
  }
  if (centre) *centre = middle;
  return boxVolume * kHollowShare * kDensity;
}

Result check(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, Options options) {
  Result out;
  const auto& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  const Vec3 down = length(options.down) > 0 ? normalized(options.down) : Vec3{0, 1, 0};
  auto present = [&](uint32_t i) { return !options.present || (i < options.present->size() && (*options.present)[i]); };

  // Each piece: its mesh, weight, centre of mass and lowest point.
  struct Weighed {
    double mass = 0;
    Vec3 centre;
  };
  std::unordered_map<std::string, Weighed> byPart;
  std::vector<std::shared_ptr<const ldraw::Mesh>> mesh(n);
  std::vector<double> mass(n, 0), low(n, -std::numeric_limits<double>::infinity());
  std::vector<Vec3> centre(n);
  double floor = -std::numeric_limits<double>::infinity();
  for (uint32_t i = 0; i < n; i++) {
    // The floor is where the whole model stands, also for a build step of it.
    const std::shared_ptr<const ldraw::Mesh> m = model.mesh(pieces[i].part, parts);
    if (!m || m->bounds.empty()) continue;
    const Box box = m->bounds.transformed(pieces[i].world);
    double lowest = -std::numeric_limits<double>::infinity();
    for (int c = 0; c < 8; c++) lowest = std::max(lowest, dot(down, Vec3{c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z}));
    floor = std::max(floor, lowest);
    if (!present(i)) continue;
    mesh[i] = m;
    low[i] = lowest;
    auto it = byPart.find(pieces[i].part);
    if (it == byPart.end()) {
      Weighed w;
      w.mass = massOf(*m, &w.centre);
      it = byPart.emplace(pieces[i].part, w).first;
    }
    mass[i] = it->second.mass;
    centre[i] = pieces[i].world.apply(it->second.centre);
  }

  // Groups: whatever is joined, among the pieces that are there.
  UnionFind uf(n);
  for (const connect::Connection& c : graph.connections)
    if (c.a < n && c.b < n && present(c.a) && present(c.b)) uf.join(c.a, c.b);
  std::unordered_map<uint32_t, uint32_t> index;
  for (uint32_t i = 0; i < n; i++) {
    if (!present(i)) continue;
    const auto [it, fresh] = index.emplace(uf.find(i), static_cast<uint32_t>(out.groups.size()));
    if (fresh) out.groups.emplace_back();
    out.groups[it->second].pieces.push_back(i);
  }
  std::sort(out.groups.begin(), out.groups.end(), [](const Group& a, const Group& b) { return a.pieces.size() != b.pieces.size() ? a.pieces.size() > b.pieces.size() : a.pieces.front() < b.pieces.front(); });

  // Seen from above: two directions square to `down`.
  const Vec3 u = normalized(cross(down, std::abs(down.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1})), v = cross(down, u);
  out.margin = std::numeric_limits<double>::infinity();
  for (uint32_t gi = 0; gi < out.groups.size(); gi++) {
    Group& g = out.groups[gi];
    Vec3 moment{};
    std::vector<Point2> feet;
    for (uint32_t i : g.pieces) {
      g.mass += mass[i];
      moment = moment + centre[i] * mass[i];
      if (!mesh[i] || low[i] < floor - kFloorSlack) continue;
      // The piece's own points on the floor.
      for (size_t k = 0; k + 2 < mesh[i]->positions.size(); k += 3) {
        const Vec3 p = pieces[i].world.apply({mesh[i]->positions[k], mesh[i]->positions[k + 1], mesh[i]->positions[k + 2]});
        if (dot(down, p) >= floor - kFloorSlack) feet.push_back({dot(u, p), dot(v, p)});
      }
    }
    out.mass += g.mass;
    if (g.mass > 0) g.centre = moment * (1 / g.mass);
    else if (!g.pieces.empty()) g.centre = pieces[g.pieces.front()].world.t;
    g.onFloor = !feet.empty();
    if (!g.onFloor) {
      // Pieces with no shape at all (a missing part) cannot be judged; the rest hang in the air.
      for (uint32_t i : g.pieces)
        if (mesh[i] && !mesh[i]->bounds.empty()) out.unsupported.push_back(i);
      continue;
    }
    g.margin = marginOf({dot(u, g.centre), dot(v, g.centre)}, hull(std::move(feet)));
    out.margin = std::min(out.margin, g.margin);
    if (!(g.margin > 0)) out.tipping.push_back(gi);
  }
  if (!std::isfinite(out.margin)) out.margin = 0;
  std::sort(out.unsupported.begin(), out.unsupported.end());
  out.stands = out.unsupported.empty() && out.tipping.empty();
  return out;
}

}  // namespace bm::stable
