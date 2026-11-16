#include "bm/kin/contact.h"

#include <algorithm>
#include <cmath>

namespace bm::kin {
namespace {
bool boxesMeet(const Box& a, const Box& b) {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
}
bool usable(const Box& b) { return !b.empty() && std::isfinite(b.min.x) && std::isfinite(b.max.x) && std::isfinite(b.min.y) && std::isfinite(b.max.y) && std::isfinite(b.min.z) && std::isfinite(b.max.z); }
}  // namespace

Contact::Contact(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes) : model_(model), graph_(graph) {
  const auto& pieces = model.pieces();
  shapes_.resize(pieces.size());
  restBox_.resize(pieces.size());
  std::unordered_map<std::string, std::shared_ptr<const collide::Shape>> byPart;
  for (size_t i = 0; i < pieces.size(); i++) {
    if (i < graph.isSegment.size() && graph.isSegment[i]) continue;
    auto it = byPart.find(pieces[i].part);
    if (it == byPart.end()) it = byPart.emplace(pieces[i].part, shapes.get(model.mesh(pieces[i].part, parts))).first;
    if (!it->second || it->second->nodes.empty()) continue;
    const Box box = it->second->bounds.transformed(pieces[i].world);
    if (!usable(box)) continue;
    shapes_[i] = it->second;
    restBox_[i] = box;
  }
}

void Contact::zonesFor(uint32_t lo, uint32_t hi, std::vector<collide::Zone>& out, bool& joined) const {
  out.clear();
  joined = false;
  const auto key = std::make_pair(lo, hi);
  const auto at = std::lower_bound(graph_.connections.begin(), graph_.connections.end(), key, [](const connect::Connection& c, const std::pair<uint32_t, uint32_t>& k) { return std::make_pair(c.a, c.b) < k; });
  for (auto it = at; it != graph_.connections.end() && it->a == lo && it->b == hi; ++it) {
    joined = joined || it->joint.kind != connect::JointKind::Flexible;
    for (uint32_t z = it->firstZone; z < it->firstZone + it->zoneCount; z++) out.push_back({graph_.zones[z].a, graph_.zones[z].b, graph_.zones[z].radius});
  }
  const auto mesh = std::lower_bound(graph_.meshes.begin(), graph_.meshes.end(), key, [](const GearMesh& m, const std::pair<uint32_t, uint32_t>& k) { return std::make_pair(std::min(m.a, m.b), std::max(m.a, m.b)) < k; });
  if (mesh != graph_.meshes.end() && std::min(mesh->a, mesh->b) == lo && std::max(mesh->a, mesh->b) == hi) {
    const connect::MateZone& z = graph_.meshZones[static_cast<size_t>(mesh - graph_.meshes.begin())];
    out.push_back({z.a, z.b, z.radius});
  }
}

bool Contact::blocked(const std::vector<uint32_t>& moved, const std::vector<uint32_t>& bodyOf, const std::vector<Xform>& motion, std::pair<uint32_t, uint32_t>* who) {
  const auto& pieces = model_.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  if (bodyOf.size() != n) return false;
  auto motionOf = [&](uint32_t piece) -> const Xform& {
    static const Xform still;
    return bodyOf[piece] < motion.size() ? motion[bodyOf[piece]] : still;
  };
  // Where every piece is now. A piece whose body did not move keeps its rest box.
  std::vector<Box> box(n);
  for (uint32_t i = 0; i < n; i++)
    if (shapes_[i]) box[i] = shapes_[i]->bounds.transformed(motionOf(i) * pieces[i].world);
  std::vector<collide::Zone> zones;
  for (uint32_t p : moved) {
    if (p >= n || !shapes_[p]) continue;
    const Xform poseP = motionOf(p) * pieces[p].world;
    for (uint32_t q = 0; q < n; q++) {
      if (!shapes_[q] || bodyOf[q] == bodyOf[p] || !boxesMeet(box[p], box[q])) continue;
      const uint32_t lo = std::min(p, q), hi = std::max(p, q);
      bool joined = false;
      zonesFor(lo, hi, zones, joined);
      const collide::Depth depth = joined ? collide::Depth::Joined : collide::Depth::Skin;
      const uint64_t key = (static_cast<uint64_t>(lo) << 32) | hi;
      // What they already do at rest is not this motion's doing. A pair that fits cleanly at
      // rest even without its zones (a pin whose collar sits exactly in its countersink) is
      // tested on its true geometry, so the collar stops the pin; a pair modelled with
      // interference (a stud inside a solid socket) keeps its zones.
      auto rest = restOverlap_.find(key);
      if (rest == restOverlap_.end()) {
        uint8_t state = 0;
        if (boxesMeet(restBox_[lo], restBox_[hi])) {
          if (collide::overlap(*shapes_[lo], pieces[lo].world, *shapes_[hi], pieces[hi].world, zones, nullptr, depth)) state = 2;
          else if (!zones.empty() && collide::overlap(*shapes_[lo], pieces[lo].world, *shapes_[hi], pieces[hi].world, {}, nullptr, depth)) state = 1;
        }
        rest = restOverlap_.emplace(key, state).first;
      }
      if (rest->second == 2) continue;
      if (rest->second == 0) zones.clear();
      const Xform& carry = motionOf(lo);
      for (collide::Zone& z : zones) {
        z.a = carry.apply(z.a);
        z.b = carry.apply(z.b);
      }
      if (collide::overlap(*shapes_[p], poseP, *shapes_[q], motionOf(q) * pieces[q].world, zones, nullptr, depth)) {
        if (who) *who = {p, q};
        return true;
      }
    }
  }
  return false;
}

}  // namespace bm::kin
