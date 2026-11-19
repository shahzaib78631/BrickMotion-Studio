#include "bmr/scene.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <tuple>

namespace bmr {
namespace {

using bm::Vec3;
using bm::Xform;

bool usable(const Xform& x) {
  for (double v : x.r.m)
    if (!std::isfinite(v)) return false;
  if (!std::isfinite(x.t.x) || !std::isfinite(x.t.y) || !std::isfinite(x.t.z)) return false;
  return std::abs(bm::determinant(x.r)) > 1e-9;
}

void write(float out[12], const Xform& x, Vec3 origin) {
  const Vec3 t = x.t - origin;
  const double rows[12] = {x.r.m[0], x.r.m[1], x.r.m[2], t.x, x.r.m[3], x.r.m[4], x.r.m[5], t.y, x.r.m[6], x.r.m[7], x.r.m[8], t.z};
  for (int i = 0; i < 12; i++) out[i] = static_cast<float>(rows[i]);
}

/// Sets one instance; notes it in `changed` if anything is different.
void set(Scene& scene, std::pair<uint32_t, uint32_t> at, const Xform& x, uint32_t flags, std::vector<std::pair<uint32_t, uint32_t>>& changed) {
  if (at.first == UINT32_MAX) return;
  Instance& in = scene.groups[at.first].instances[at.second];
  float model[12];
  write(model, x, scene.origin);
  if (in.flags == flags && std::memcmp(model, in.model, sizeof model) == 0) return;
  std::memcpy(in.model, model, sizeof model);
  in.flags = flags;
  changed.push_back(at);
}

}  // namespace

Scene buildScene(const bm::Model& model, bm::ldraw::PartCache& parts, size_t* skipped) {
  Scene scene;
  if (skipped) *skipped = 0;
  const auto& pieces = model.pieces();
  scene.where.assign(pieces.size(), {UINT32_MAX, UINT32_MAX});
  struct Key {
    bool transparent;
    std::string part;
    int color;
    bool operator<(const Key& o) const { return std::tie(transparent, part, color) < std::tie(o.transparent, o.part, o.color); }
  };
  std::map<Key, Group> groups;
  std::map<std::string, std::pair<bm::Box, bool>> boxOf;  // a part's box, and whether it is a placeholder
  std::vector<std::pair<Key, uint32_t>> placed(pieces.size());
  std::vector<uint8_t> kept(pieces.size(), 0);
  for (uint32_t i = 0; i < pieces.size(); i++) {
    const bm::Piece& p = pieces[i];
    if (!usable(p.world)) {
      if (skipped) (*skipped)++;
      continue;
    }
    auto found = boxOf.find(p.part);
    if (found == boxOf.end()) {
      const auto mesh = model.mesh(p.part, parts);
      const bool none = mesh->triangles.empty() || mesh->bounds.empty();
      found = boxOf.emplace(p.part, std::make_pair(none ? bm::kPlaceholderBox : mesh->bounds, none)).first;
    }
    const bool placeholder = found->second.second;
    const Material material = placeholder ? placeholderMaterial() : materialFor(colorFor(model.library(), p.color));
    const Key key{material.transparent(), p.part, p.color};
    Group& g = groups[key];
    if (g.instances.empty()) g.part = p.part, g.color = p.color, g.material = material, g.placeholder = placeholder, g.partBox = found->second.first;
    Instance in{};
    in.piece = i;
    in.flags = bm::determinant(p.world.r) < 0 ? kMirrored : 0;
    placed[i] = {key, static_cast<uint32_t>(g.instances.size())};
    kept[i] = 1;
    g.instances.push_back(in);
    g.restBoxes.push_back(found->second.first.transformed(p.world));
    scene.bounds.merge(g.restBoxes.back());
  }
  if (!scene.bounds.empty()) scene.origin = (scene.bounds.min + scene.bounds.max) * 0.5;
  std::map<Key, uint32_t> index;
  for (auto& [key, g] : groups) {
    index[key] = static_cast<uint32_t>(scene.groups.size());
    for (Instance& in : g.instances) write(in.model, pieces[in.piece].world, scene.origin);
    scene.groups.push_back(std::move(g));
  }
  for (uint32_t i = 0; i < pieces.size(); i++)
    if (kept[i]) scene.where[i] = {index[placed[i].first], placed[i].second};
  return scene;
}

std::vector<std::pair<uint32_t, uint32_t>> applyRest(Scene& scene, const bm::Model& model) {
  std::vector<std::pair<uint32_t, uint32_t>> changed;
  const auto& pieces = model.pieces();
  for (uint32_t i = 0; i < pieces.size() && i < scene.where.size(); i++) {
    if (scene.where[i].first == UINT32_MAX) continue;
    const uint32_t keep = scene.groups[scene.where[i].first].instances[scene.where[i].second].flags & (kMirrored | kSelected | kUserHidden);
    set(scene, scene.where[i], pieces[i].world, keep, changed);
  }
  return changed;
}

std::vector<std::pair<uint32_t, uint32_t>> applyFrame(Scene& scene, const bm::Model& model, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, double frame) {
  const auto& pieces = model.pieces();
  const size_t n = std::min(pieces.size(), scene.where.size());
  // Where each piece is: at rest unless a flight says otherwise.
  std::vector<Xform> pose(n);
  std::vector<uint8_t> hidden(n, 0);
  for (size_t i = 0; i < n; i++) pose[i] = pieces[i].world;
  // A piece goes where the innermost flight that moves it says, carried by the units it is in.
  std::vector<int> owner(n, -1);
  for (size_t fi = 0; fi < timeline.flights.size(); fi++) {
    const bm::plan::Flight& flight = timeline.flights[fi];
    if (flight.pieces.empty() && flight.move >= plan.moves.size()) continue;
    for (uint32_t p : bm::plan::piecesOf(flight, plan))
      if (p < n && (owner[p] < 0 || timeline.flights[static_cast<size_t>(owner[p])].depth < flight.depth)) owner[p] = static_cast<int>(fi);
  }
  std::vector<Xform> motion(timeline.flights.size());
  std::vector<uint8_t> known(timeline.flights.size(), 0);
  for (size_t i = 0; i < n; i++) {
    if (owner[i] < 0) continue;
    const size_t fi = static_cast<size_t>(owner[i]);
    const bm::plan::Flight& flight = timeline.flights[fi];
    if (!known[fi]) motion[fi] = bm::plan::motionAt(timeline, fi, frame), known[fi] = 1;
    if (!bm::plan::shownAt(flight, frame)) hidden[i] = 1;
    pose[i] = motion[fi] * pieces[i].world;
  }
  std::vector<std::pair<uint32_t, uint32_t>> changed;
  for (uint32_t i = 0; i < n; i++) {
    if (scene.where[i].first == UINT32_MAX) continue;
    const uint32_t keep = scene.groups[scene.where[i].first].instances[scene.where[i].second].flags & (kMirrored | kSelected | kUserHidden);
    set(scene, scene.where[i], pose[i], keep | (hidden[i] ? kHidden : 0), changed);
  }
  return changed;
}

namespace {
/// Exactly these pieces have `bit`; returns what changed.
std::vector<std::pair<uint32_t, uint32_t>> markExactly(Scene& scene, const std::vector<uint32_t>& pieces, uint32_t bit) {
  std::vector<uint8_t> on(scene.where.size(), 0);
  for (uint32_t p : pieces)
    if (p < on.size()) on[p] = 1;
  std::vector<std::pair<uint32_t, uint32_t>> changed;
  for (uint32_t i = 0; i < scene.where.size(); i++) {
    if (scene.where[i].first == UINT32_MAX) continue;
    Instance& in = scene.groups[scene.where[i].first].instances[scene.where[i].second];
    const uint32_t flags = on[i] ? (in.flags | bit) : (in.flags & ~bit);
    if (flags == in.flags) continue;
    in.flags = flags;
    changed.push_back(scene.where[i]);
  }
  return changed;
}
}  // namespace

std::vector<std::pair<uint32_t, uint32_t>> applySelection(Scene& scene, const std::vector<uint32_t>& selected) { return markExactly(scene, selected, kSelected); }

std::vector<std::pair<uint32_t, uint32_t>> applyUserHidden(Scene& scene, const std::vector<uint32_t>& pieces) { return markExactly(scene, pieces, kUserHidden); }

std::vector<std::pair<uint32_t, uint32_t>> applyMoved(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces) {
  std::vector<std::pair<uint32_t, uint32_t>> changed;
  const auto& all = model.pieces();
  for (uint32_t p : pieces) {
    if (p >= all.size() || p >= scene.where.size() || scene.where[p].first == UINT32_MAX) continue;
    const Xform& world = all[p].world;
    if (!usable(world)) continue;  // a placement that cannot be drawn: the instance stays where it was
    const auto [g, i] = scene.where[p];
    Group& group = scene.groups[g];
    const uint32_t flags = (group.instances[i].flags & ~kMirrored) | (bm::determinant(world.r) < 0 ? kMirrored : 0);
    set(scene, scene.where[p], world, flags, changed);
    group.restBoxes[i] = group.partBox.transformed(world);
    scene.bounds.merge(group.restBoxes[i]);
  }
  return changed;
}

void applyRecolored(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces) {
  const auto& all = model.pieces();
  for (uint32_t p : pieces) {
    if (p >= all.size() || p >= scene.where.size() || scene.where[p].first == UINT32_MAX) continue;
    const auto [from, at] = scene.where[p];
    const int color = all[p].color;
    if (scene.groups[from].color == color) continue;
    const bool placeholder = scene.groups[from].placeholder;
    const std::string part = scene.groups[from].part;
    const bm::Box partBox = scene.groups[from].partBox;
    const Material material = placeholder ? placeholderMaterial() : materialFor(colorFor(model.library(), color));
    // Its new group, made at the end of its run when there is none.
    uint32_t to = UINT32_MAX;
    for (uint32_t g = 0; g < scene.groups.size(); g++)
      if (scene.groups[g].part == part && scene.groups[g].color == color && scene.groups[g].placeholder == placeholder) to = g;
    if (to == UINT32_MAX) {
      uint32_t end = static_cast<uint32_t>(scene.groups.size());
      if (!material.transparent()) {
        end = 0;
        while (end < scene.groups.size() && !scene.groups[end].material.transparent()) end++;
      }
      Group g;
      g.part = part, g.color = color, g.material = material, g.placeholder = placeholder, g.partBox = partBox;
      scene.groups.insert(scene.groups.begin() + end, std::move(g));
      for (auto& w : scene.where)
        if (w.first != UINT32_MAX && w.first >= end) w.first++;
      to = end;
    }
    const uint32_t source = scene.where[p].first;  // may have shifted
    Group& old = scene.groups[source];
    Instance moved = old.instances[at];
    const bm::Box box = old.restBoxes[at];
    // Out of its old group: the last instance takes its place.
    const uint32_t last = static_cast<uint32_t>(old.instances.size() - 1);
    if (at != last) {
      old.instances[at] = old.instances[last];
      old.restBoxes[at] = old.restBoxes[last];
      scene.where[old.instances[at].piece] = {source, at};
    }
    old.instances.pop_back();
    old.restBoxes.pop_back();
    Group& target = scene.groups[to];
    scene.where[p] = {to, static_cast<uint32_t>(target.instances.size())};
    target.instances.push_back(moved);
    target.restBoxes.push_back(box);
  }
}

}  // namespace bmr
