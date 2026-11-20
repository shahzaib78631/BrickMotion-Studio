#include <algorithm>
#include <functional>
#include "bm/collide/pair.h"
#include "bm/collide/world.h"
#include "bm/connect/infer.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

namespace bm::plan {

std::vector<connect::Correction> correctPlacements(Model& model, connect::ConnectorDb& connectors, ldraw::PartCache& parts, collide::ShapeCache& shapes, bool apply) {
  std::vector<uint8_t> settled(model.pieces().size(), 0), applied(model.pieces().size(), 0);
  // What a corrected piece holds was placed against where the file has it: it may be a little
  // off too (a pistol turned 4 degrees in its clip). Each such piece is set onto it as well.
  auto find = [&](const collide::World& world) {
    connect::Graph graph = connect::buildGraph(model, connectors, nullptr);
    std::vector<std::pair<uint32_t, uint32_t>> settle;
    for (const connect::Connection& c : graph.connections) {
      if (applied[c.a] && !settled[c.b]) settle.push_back({c.b, c.a});
      if (applied[c.b] && !settled[c.a]) settle.push_back({c.a, c.b});
    }
    std::vector<connect::Correction> got = connect::inferJoints(graph, model, connectors, world, settle).corrections;
    // Two pieces joined to nothing else, each off the other: one of them moves, the smaller
    // (the accessory onto its holder, not the holder onto it); the larger stays where it is.
    auto volume = [&](uint32_t p) {
      const Box b = world.box(p);
      return b.empty() ? 0.0 : (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    };
    std::vector<uint32_t> ontoOf(model.pieces().size(), UINT32_MAX);
    for (const connect::Correction& c : got) ontoOf[c.piece] = c.onto;
    std::erase_if(got, [&](const connect::Correction& c) {
      if (ontoOf[c.onto] != c.piece) return false;
      const double mine = volume(c.piece), theirs = volume(c.onto);
      return mine != theirs ? mine > theirs : c.piece < c.onto;
    });
    return got;
  };
  if (!apply) {  // what --correct would do, worked out on a copy, so the listing is the same
    Model scratch = model;
    std::vector<connect::Correction> would = correctPlacements(scratch, connectors, parts, shapes, true);
    for (connect::Correction& c : would)
      if (c.applied) c.applied = false;
    return would;
  }
  // In rounds: a piece held by one that is itself off (a pistol's barrel on its off grip) is
  // set in place once what holds it is, against where that now is.
  std::vector<connect::Correction> all;
  for (int round = 0; round < 4; round++) {
    const collide::World world(model, parts, shapes);
    std::vector<connect::Correction> found = find(world);
    std::vector<uint8_t> moving(model.pieces().size(), 0);
    for (const connect::Correction& c : found) moving[c.piece] = 1;
    bool any = false;
    const std::vector<Piece>& pieces = model.pieces();
    std::vector<uint32_t> near;
    for (connect::Correction& c : found) {
      if (settled[c.piece]) continue;
      if (moving[c.onto]) continue;  // next round
      settled[c.piece] = 1;
      const collide::Shape& mine = world.shape(c.piece);
      // What it might touch, where the file has it or where it belongs.
      Box reach = world.box(c.piece);
      for (const Vec3& corner : {reach.min, reach.max}) reach.grow(c.to.apply(c.from.inverse().apply(corner)));
      reach.min = reach.min - Vec3{2, 2, 2}, reach.max = reach.max + Vec3{2, 2, 2};
      near.clear();
      world.near(reach, nullptr, near);
      for (uint32_t q : near) {
        if (q == c.piece || q == c.onto) continue;
        const collide::Shape& other = world.shape(q);
        if (collide::overlap(mine, c.to, other, pieces[q].world) && !collide::overlap(mine, c.from, other, pieces[q].world)) {
          c.note = "in place it would cross " + pieces[q].part + " " + pieces[q].id;
          break;
        }
      }
      if (c.note.empty()) model.setPlacement(c.piece, c.to), c.applied = true, applied[c.piece] = 1, any = true;
      all.push_back(c);
    }
    if (!any) {
      for (const connect::Correction& c : found)  // held by what could not be set in place
        if (!settled[c.piece]) all.push_back(c), all.back().note = "what holds it is off too, and was not set in place";
      break;
    }
  }
  return all;
}

Plan planModel(Model& model, connect::Graph& graph, connect::ConnectorDb& connectors, const kin::GearDb* gears, ldraw::PartCache& parts,
               collide::ShapeCache& shapes, const Options& options, connect::Inferred* inferred, std::vector<connect::Correction>* corrections) {
  std::vector<connect::Correction> found = correctPlacements(model, connectors, parts, shapes, options.correctPlacements);
  graph = connect::buildGraph(model, connectors, gears);
  Plan out = planInferred(model, graph, connectors, parts, shapes, options, inferred);
  const bool anyApplied = std::any_of(found.begin(), found.end(), [](const connect::Correction& c) { return c.applied; });
  if (anyApplied && out.complete) {
    const size_t n = model.pieces().size();
    std::vector<uint8_t> unbuilt(n, 0);
    std::function<void(const Plan&)> mark = [&](const Plan& p) {
      for (const Move& m : p.moves)
        if (!flown(m.flag) || m.path.empty())
          for (uint32_t q : m.unit.pieces)
            if (q < n) unbuilt[q] = 1;
      for (const Plan& s : p.subs) mark(s);
    };
    mark(out);
    std::vector<std::vector<uint32_t>> joinedTo(n);
    for (const connect::Connection& c : graph.connections) joinedTo[c.a].push_back(c.b), joinedTo[c.b].push_back(c.a);
    std::vector<uint8_t> back(n, 0);
    bool any = false;
    for (const connect::Correction& c : found) {
      if (!c.applied) continue;
      bool bad = unbuilt[c.piece] != 0;
      for (uint32_t q : joinedTo[c.piece]) bad = bad || unbuilt[q];
      if (bad) back[c.piece] = 1, any = true;
    }
    if (any) {
      // What was set onto a piece that goes back goes back too: it was placed against it.
      for (bool more = true; more;) {
        more = false;
        for (const connect::Correction& c : found)
          if (c.applied && !back[c.piece] && back[c.onto]) back[c.piece] = 1, more = true;
      }
      for (connect::Correction& c : found)
        if (c.applied && back[c.piece]) {
          model.setPlacement(c.piece, c.from);
          c.applied = false;
          c.note = "set back: in place, the plan left it or a piece joined to it unbuilt";
        }
      graph = connect::buildGraph(model, connectors, gears);
      out = planInferred(model, graph, connectors, parts, shapes, options, inferred);
    }
  }
  if (corrections) *corrections = std::move(found);
  return out;
}

nlohmann::json toJson(const std::vector<connect::Correction>& corrections, const Model& model) {
  nlohmann::json out = nlohmann::json::array();
  auto placement = [](const Xform& x) {
    nlohmann::json m = nlohmann::json::array();
    for (double v : x.r.m) m.push_back(v);
    return nlohmann::json{{"r", m}, {"t", {x.t.x, x.t.y, x.t.z}}};
  };
  const std::vector<Piece>& pieces = model.pieces();
  for (const connect::Correction& c : corrections) {
    nlohmann::json j = {{"piece", pieces[c.piece].id}, {"part", pieces[c.piece].part}, {"onto", pieces[c.onto].id}, {"ontoPart", pieces[c.onto].part},
                        {"offset", c.offset}, {"along", c.along}, {"angle", c.angle}, {"from", placement(c.from)}, {"to", placement(c.to)}, {"applied", c.applied}};
    if (!c.note.empty()) j["note"] = c.note;
    out.push_back(j);
  }
  return out;
}

}  // namespace bm::plan
