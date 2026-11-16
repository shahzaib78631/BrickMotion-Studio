#include "bm/kin/truth.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

using nlohmann::json;

/// How close the centre of a piece's box must be to the position the list gives for it (the
/// lists' own default; a file may set "toleranceLdu").
constexpr double kNear = 12.0;
/// An axis in the list and a motion found agree above this cosine (18 degrees): the lists
/// give axes to two decimals, and a piston's line is rarely square to anything.
constexpr double kAxisAgree = 0.95;

bool readVec(const json& j, Vec3& out) {
  if (!j.is_array() || j.size() != 3 || !j[0].is_number() || !j[1].is_number() || !j[2].is_number()) return false;
  out = {j[0].get<double>(), j[1].get<double>(), j[2].get<double>()};
  return true;
}

std::string text(const char* format, double a, double b = 0) {
  char buf[128];
  std::snprintf(buf, sizeof buf, format, a, b);
  return buf;
}

struct Scorer {
  const Model& model;
  const connect::Graph& graph;
  const System& sys;
  const Mobility& mob;
  std::vector<Vec3> centre;  ///< per piece: the middle of its box in the model
  double tolerance = kNear;

  /// The piece a reference names, or -1.
  int piece(const json& ref) const {
    Vec3 at;
    if (!ref.is_object() || !ref.contains("part") || !ref["part"].is_string() || !ref.contains("at") || !readVec(ref["at"], at)) return -1;
    std::string part = ref["part"].get<std::string>();
    std::transform(part.begin(), part.end(), part.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (part.size() < 4 || part.compare(part.size() - 4, 4, ".dat") != 0) part += ".dat";
    int best = -1;
    double bestD = tolerance;
    for (size_t i = 0; i < model.pieces().size(); i++) {
      if (model.pieces()[i].part != part) continue;
      const double d = length(centre[i] - at);
      if (d <= bestD) bestD = d, best = static_cast<int>(i);
    }
    return best;
  }
  uint32_t body(int piece) const { return sys.bodyOf[static_cast<size_t>(piece)]; }
  Vec3 at(int piece) const { return centre[static_cast<size_t>(piece)]; }
  /// Whether the freedom moves the piece at all (it turns, or its origin travels).
  bool moves(const Freedom& f, int p) const {
    const Twist t = twistOf(f, body(p));
    return length(t.angular) > 1e-6 || length(velocityAt(t, at(p))) > 1e-4;
  }
  bool turnsAbout(const Freedom& f, int p, Vec3 axis) const {
    const Vec3 w = twistOf(f, body(p)).angular;
    return length(w) > 1e-6 && std::abs(dot(w, axis)) >= kAxisAgree * length(w);
  }
  bool travelsAlong(const Freedom& f, int p, Vec3 axis) const {
    const Vec3 v = velocityAt(twistOf(f, body(p)), at(p));
    return length(v) > 1e-4 && std::abs(dot(v, axis)) >= kAxisAgree * length(v);
  }
  const GearMesh* mesh(int a, int b) const {
    for (const GearMesh& m : graph.meshes)
      if ((static_cast<int>(m.a) == a && static_cast<int>(m.b) == b) || (static_cast<int>(m.a) == b && static_cast<int>(m.b) == a)) return &m;
    return nullptr;
  }

  TruthLine check(const json& c) const {
    TruthLine line;
    line.type = c.value("type", "");
    line.label = c.value("label", "");
    auto done = [&](TruthResult r, std::string detail = "") {
      line.result = r;
      line.detail = std::move(detail);
      return line;
    };
    const std::string& type = line.type;
    if (type == "rotates" || type == "slides") {
      Vec3 axis;
      const int p = c.contains("part") ? piece(c["part"]) : -1;
      if (p < 0 || !c.contains("axis") || !readVec(c["axis"], axis) || length(axis) == 0) return done(TruthResult::Unresolved, "piece or axis not found");
      axis = normalized(axis);
      bool any = false;
      for (const Freedom& f : mob.freedoms) {
        any = any || moves(f, p);
        if (type == "rotates" ? turnsAbout(f, p, axis) : travelsAlong(f, p, axis)) return done(TruthResult::Hit);
      }
      return done(TruthResult::Missing, any ? "it moves, but not that way" : "nothing moves it");
    }
    if (type == "gearMesh" || type == "rackPinion") {
      const bool rack = type == "rackPinion";
      const char *ka = rack ? "pinion" : "a", *kb = rack ? "rack" : "b";
      const int a = c.contains(ka) ? piece(c[ka]) : -1, b = c.contains(kb) ? piece(c[kb]) : -1;
      if (a < 0 || b < 0) return done(TruthResult::Unresolved, "piece not found");
      const GearMesh* m = mesh(a, b);
      if (!m) return done(TruthResult::Missing, "not meshed");
      if (rack && m->kind != MeshKind::Rack) return done(TruthResult::Missing, "meshed, but not as a rack");
      if (c.contains("ratio") && c["ratio"].is_number()) {
        const int ta = static_cast<int>(m->a) == a ? m->teethA : m->teethB, tb = static_cast<int>(m->a) == a ? m->teethB : m->teethA;
        const double found = ta ? static_cast<double>(tb) / ta : 0;
        if (std::abs(found - c["ratio"].get<double>()) > 0.002) return done(TruthResult::Missing, text("ratio %.3f, expected %.3f", found, c["ratio"].get<double>()));
      }
      return done(TruthResult::Hit);
    }
    if (type == "fourBar") {
      Vec3 axis;
      const int coupler = c.contains("coupler") ? piece(c["coupler"]) : -1;
      if (coupler < 0 || !c.contains("arms") || !c["arms"].is_array() || !c.contains("axis") || !readVec(c["axis"], axis)) return done(TruthResult::Unresolved, "piece or axis not found");
      axis = normalized(axis);
      std::vector<int> arms;
      for (const json& ref : c["arms"]) {
        arms.push_back(piece(ref));
        if (arms.back() < 0) return done(TruthResult::Unresolved, "arm not found");
      }
      for (const Freedom& f : mob.freedoms) {
        if (!moves(f, coupler)) continue;
        if (std::all_of(arms.begin(), arms.end(), [&](int arm) { return turnsAbout(f, arm, axis); })) return done(TruthResult::Hit);
      }
      return done(TruthResult::Missing, "no freedom moves the coupler and turns every arm");
    }
    if (type == "function") {
      const int driver = c.contains("driver") ? piece(c["driver"]) : -1;
      if (driver < 0) return done(TruthResult::Unresolved, "driver not found");
      std::vector<int> movers, stayers;
      for (const char* key : {"moves", "stays"}) {
        if (!c.contains(key)) continue;
        if (!c[key].is_array()) return done(TruthResult::Unresolved, "malformed list");
        for (const json& ref : c[key]) {
          const int p = piece(ref);
          if (p < 0) return done(TruthResult::Unresolved, std::string("a piece listed in ") + key + " is not in the model");
          (std::string(key) == "moves" ? movers : stayers).push_back(p);
        }
      }
      size_t best = 0;
      bool driven = false, disturbed = false;
      for (const Freedom& f : mob.freedoms) {
        if (!moves(f, driver)) continue;
        driven = true;
        const size_t moved = static_cast<size_t>(std::count_if(movers.begin(), movers.end(), [&](int p) { return moves(f, p); }));
        const bool stays = std::none_of(stayers.begin(), stayers.end(), [&](int p) { return moves(f, p); });
        if (moved == movers.size() && stays) return done(TruthResult::Hit);
        if (moved >= best) best = moved, disturbed = !stays;
      }
      if (!driven) return done(TruthResult::Missing, "nothing moves the driver");
      return done(TruthResult::Missing, text("the driver's freedom moves %.0f of %.0f listed pieces", static_cast<double>(best), static_cast<double>(movers.size())) + (disturbed ? ", and one that should stay" : ""));
    }
    return done(TruthResult::NotScored);
  }
};

}  // namespace

TruthScore score(const Model& model, const connect::Graph& graph, const System& sys, const Mobility& mob, ldraw::PartCache& parts, const json& expected) {
  TruthScore out;
  if (!expected.is_object() || !expected.contains("mechanisms") || !expected["mechanisms"].is_array() || sys.bodyOf.size() != model.pieces().size()) return out;
  Scorer scorer{model, graph, sys, mob, {}, kNear};
  if (expected.contains("toleranceLdu") && expected["toleranceLdu"].is_number()) scorer.tolerance = expected["toleranceLdu"].get<double>();
  for (const Piece& p : model.pieces()) {
    const Box box = model.mesh(p.part, parts)->bounds.transformed(p.world);
    scorer.centre.push_back(box.empty() ? p.world.t : (box.min + box.max) * 0.5);
  }
  for (const json& mechanism : expected["mechanisms"]) {
    if (!mechanism.is_object() || !mechanism.contains("checks") || !mechanism["checks"].is_array()) continue;
    for (const json& c : mechanism["checks"]) {
      TruthLine line;
      if (c.is_object()) line = scorer.check(c);
      else line.result = TruthResult::Unresolved, line.detail = "not a check";
      line.mechanism = mechanism.value("id", "");
      switch (line.result) {
        case TruthResult::Hit: out.hit++; break;
        case TruthResult::Missing: out.missing++; break;
        case TruthResult::NotScored: out.notScored++; break;
        case TruthResult::Unresolved: out.unresolved++; break;
      }
      out.lines.push_back(std::move(line));
    }
  }
  return out;
}

const char* name(TruthResult result) {
  switch (result) {
    case TruthResult::Hit: return "hit";
    case TruthResult::Missing: return "missing";
    case TruthResult::NotScored: return "not scored";
    case TruthResult::Unresolved: return "unresolved";
  }
  return "missing";
}

}  // namespace bm::kin
