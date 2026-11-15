#include "bm/collide/world.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_map>

namespace bm::collide {
namespace {

bool boxesMeet(const Box& a, const Box& b) {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
}

/// One shape per distinct part of the model (a model's own inline parts are built here).
std::vector<std::shared_ptr<const Shape>> shapesOf(const Model& model, ldraw::PartCache& parts, ShapeCache& shapes) {
  std::vector<std::shared_ptr<const Shape>> out;
  out.reserve(model.pieces().size());
  std::unordered_map<std::string, std::shared_ptr<const Shape>> byPart;
  for (const Piece& p : model.pieces()) {
    auto it = byPart.find(p.part);
    if (it == byPart.end()) it = byPart.emplace(p.part, shapes.get(model.mesh(p.part, parts))).first;
    out.push_back(it->second);
  }
  return out;
}

bool samePose(const Piece& a, const Piece& b) {
  if (a.part != b.part || length(a.world.t - b.world.t) > 1e-3) return false;
  for (int i = 0; i < 9; i++)
    if (std::abs(a.world.r.m[i] - b.world.r.m[i]) > 1e-4) return false;
  return true;
}

/// The rotation part of `m` as an axis and an angle. False if `m` is not a rotation.
bool axisAngle(const Mat3& m, Vec3& axis, double& angle) {
  const double tr = m.m[0] + m.m[4] + m.m[8];
  if (std::abs(determinant(m) - 1) > 1e-3) return false;
  angle = std::acos(std::min(1.0, std::max(-1.0, (tr - 1) / 2)));
  if (angle < 1e-9) {
    axis = {0, 1, 0};
    angle = 0;
    return true;
  }
  if (3.14159265358979 - angle < 1e-6) {
    // Half a turn: the axis is the largest column of (m + I).
    const Vec3 cols[3] = {{m.m[0] + 1, m.m[3], m.m[6]}, {m.m[1], m.m[4] + 1, m.m[7]}, {m.m[2], m.m[5], m.m[8] + 1}};
    axis = cols[0];
    for (const Vec3& c : cols)
      if (length(c) > length(axis)) axis = c;
    axis = normalized(axis);
    return true;
  }
  axis = normalized(Vec3{m.m[7] - m.m[5], m.m[2] - m.m[6], m.m[3] - m.m[1]});
  return true;
}

Mat3 rotation(Vec3 k, double angle) {
  const double c = std::cos(angle), s = std::sin(angle), v = 1 - c;
  return Mat3{{c + k.x * k.x * v, k.x * k.y * v - k.z * s, k.x * k.z * v + k.y * s, k.y * k.x * v + k.z * s, c + k.y * k.y * v, k.y * k.z * v - k.x * s, k.z * k.x * v - k.y * s, k.z * k.y * v + k.x * s,
               c + k.z * k.z * v}};
}

}  // namespace

Report findOverlaps(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, ShapeCache& shapeCache) {
  Report report;
  const std::vector<Piece>& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  if (graph.isSegment.size() != n) return report;  // a graph of another model
  const auto shapes = shapesOf(model, parts, shapeCache);

  // Sort and sweep on x over the pieces that can collide.
  std::vector<Box> boxes(n);
  std::vector<uint32_t> order;
  for (uint32_t i = 0; i < n; i++) {
    if (graph.isSegment[i] || shapes[i]->nodes.empty()) continue;
    boxes[i] = shapes[i]->bounds.transformed(pieces[i].world);
    if (!boxes[i].empty() && std::isfinite(boxes[i].min.x) && std::isfinite(boxes[i].max.x)) order.push_back(i);
  }
  std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return boxes[a].min.x < boxes[b].min.x; });

  // The pair's mate zones; returns whether the two are joined at all.
  auto zonesFor = [&](uint32_t a, uint32_t b, std::vector<Zone>& out) {
    out.clear();
    bool joined = false;
    const auto at = std::lower_bound(graph.connections.begin(), graph.connections.end(), std::make_pair(a, b), [](const connect::Connection& c, const std::pair<uint32_t, uint32_t>& key) { return c.a != key.first ? c.a < key.first : c.b < key.second; });
    for (auto it = at; it != graph.connections.end() && it->a == a && it->b == b; ++it) {
      joined = joined || it->joint.kind != connect::JointKind::Flexible;
      for (uint32_t z = it->firstZone; z < it->firstZone + it->zoneCount; z++) out.push_back({graph.zones[z].a, graph.zones[z].b, graph.zones[z].radius});
    }
    return joined;
  };

  std::vector<Zone> zones;
  for (size_t i = 0; i < order.size(); i++) {
    const uint32_t a = order[i];
    for (size_t j = i + 1; j < order.size() && boxes[order[j]].min.x <= boxes[a].max.x; j++) {
      const uint32_t b = order[j];
      if (!boxesMeet(boxes[a], boxes[b])) continue;
      const uint32_t lo = std::min(a, b), hi = std::max(a, b);
      report.tested++;
      if (samePose(pieces[lo], pieces[hi])) {
        report.overlaps.push_back({lo, hi, pieces[lo].world.t, true, {}});
        continue;
      }
      const bool joined = zonesFor(lo, hi, zones);
      Hit hit;
      if (overlap(*shapes[lo], pieces[lo].world, *shapes[hi], pieces[hi].world, zones, &hit, joined ? Depth::Joined : Depth::Skin)) report.overlaps.push_back({lo, hi, hit.point, false, hit});
    }
  }
  std::sort(report.overlaps.begin(), report.overlaps.end(), [](const Overlap& x, const Overlap& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
  return report;
}

struct World::State {
  std::vector<std::shared_ptr<const Shape>> shapes;
  std::vector<Xform> poses;
  std::vector<Box> boxes;
  std::vector<uint32_t> byMinX;  // pieces with geometry, sorted by their box's min x
  double widest = 0;             // the largest box extent along x, to bound the scan
};

World::World(const Model& model, ldraw::PartCache& parts, ShapeCache& shapeCache) : state_(std::make_unique<State>()) {
  state_->shapes = shapesOf(model, parts, shapeCache);
  const uint32_t n = static_cast<uint32_t>(model.pieces().size());
  state_->boxes.resize(n);
  for (uint32_t i = 0; i < n; i++) {
    state_->poses.push_back(model.pieces()[i].world);
    if (state_->shapes[i]->nodes.empty()) continue;
    state_->boxes[i] = state_->shapes[i]->bounds.transformed(state_->poses[i]);
    if (state_->boxes[i].empty() || !std::isfinite(state_->boxes[i].min.x) || !std::isfinite(state_->boxes[i].max.x)) continue;
    state_->byMinX.push_back(i);
    state_->widest = std::max(state_->widest, state_->boxes[i].max.x - state_->boxes[i].min.x);
  }
  std::sort(state_->byMinX.begin(), state_->byMinX.end(), [&](uint32_t a, uint32_t b) { return state_->boxes[a].min.x < state_->boxes[b].min.x; });
}

World::~World() = default;
size_t World::size() const { return state_->poses.size(); }

std::optional<uint32_t> World::hits(const Shape& shape, const Xform& xf, const std::vector<uint32_t>& ignore, const std::vector<Zone>& zones) const {
  if (shape.nodes.empty()) return std::nullopt;
  const Box box = shape.bounds.transformed(xf);
  if (box.empty() || !std::isfinite(box.min.x) || !std::isfinite(box.max.x)) return std::nullopt;
  const State& s = *state_;
  // Pieces whose box can reach this one start no further left than box.min.x - widest.
  auto first = std::lower_bound(s.byMinX.begin(), s.byMinX.end(), box.min.x - s.widest, [&](uint32_t i, double x) { return s.boxes[i].min.x < x; });
  std::optional<uint32_t> best;
  for (auto it = first; it != s.byMinX.end() && s.boxes[*it].min.x <= box.max.x; ++it) {
    const uint32_t i = *it;
    if (best && i > *best) continue;  // report the lowest piece index, whatever the scan order
    if (!boxesMeet(box, s.boxes[i]) || std::find(ignore.begin(), ignore.end(), i) != ignore.end()) continue;
    if (overlap(shape, xf, *s.shapes[i], s.poses[i], zones)) best = i;
  }
  return best;
}

std::optional<double> World::sweep(const Shape& shape, const Xform& from, const Xform& to, const std::vector<uint32_t>& ignore, const std::vector<Zone>& zones) const {
  if (shape.nodes.empty()) return std::nullopt;
  // How far any point of the shape travels: the straight move plus the arc its far corner turns through.
  Vec3 axis;
  double angle = 0;
  const bool turns = std::abs(determinant(from.r)) > 1e-9 && axisAngle(from.r.m[0] == to.r.m[0] && from.r.m[4] == to.r.m[4] && from.r.m[8] == to.r.m[8] && from.r.m[1] == to.r.m[1] ? Mat3::identity() : bm::inverse(from.r) * to.r, axis, angle) && angle > 0;
  double reach = 0;
  for (double v : {shape.bounds.min.x, shape.bounds.max.x, shape.bounds.min.y, shape.bounds.max.y, shape.bounds.min.z, shape.bounds.max.z}) reach = std::max(reach, std::abs(v));
  const double travel = length(to.t - from.t) + (turns ? angle * reach * 1.7321 : 0);
  if (!std::isfinite(travel)) return std::nullopt;
  const int steps = std::max(1, std::min(kMaxSweepSteps, static_cast<int>(std::ceil(travel / kSweepStep))));
  for (int i = 0; i <= steps; i++) {
    const double u = static_cast<double>(i) / steps;
    Xform pose;
    pose.t = from.t + (to.t - from.t) * u;
    pose.r = turns ? from.r * rotation(axis, angle * u) : (i == steps ? to.r : from.r);
    if (hits(shape, pose, ignore, zones)) return u;
  }
  return std::nullopt;
}

}  // namespace bm::collide
