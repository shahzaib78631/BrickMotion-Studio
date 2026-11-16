#include "bm/kin/truth.h"
#include "bm/kin/drive.h"

#include <memory>

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
/// How far a function's driver is driven, a stretch at a time, to see what it moves: radians,
/// or LDU. Eight turns of a knob take a linear actuator a third of its stroke, enough for the
/// housing to swing; until joint limits are known nothing says where the real range ends.
constexpr double kDriveTurn = 8 * 6.283185307179586, kDriveTravel = 80.0;
constexpr int kDriveStretches = 32;
/// The step it is driven at: coarser than a drive made to be looked at.
constexpr double kScoreStep = 0.2;
/// A piece has moved when its middle has gone this far (LDU) or it has turned one degree.
constexpr double kMovedLdu = 0.5, kMovedTurn = 0.017453;

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
  const std::vector<Shift>* shifts = nullptr;
  mutable std::vector<std::unique_ptr<Mobility>> shiftMob;  ///< per shift, once asked for

  /// The freedoms with one shift made and every other left where it is.
  const Mobility& with(size_t shift) const {
    if (shiftMob.size() != shifts->size()) shiftMob.resize(shifts->size());
    if (!shiftMob[shift]) shiftMob[shift] = std::make_unique<Mobility>(mobility(shifted(sys, {(*shifts)[shift]})));
    return *shiftMob[shift];
  }
  size_t shiftCount() const { return shifts ? shifts->size() : 0; }

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
  /// Whether, in this freedom, the piece's body moves along `axis` against a body it is joined
  /// to by a slide along that axis.
  bool slidesInPartner(const Freedom& f, int p, Vec3 axis) const {
    const uint32_t b = body(p);
    for (const Link& l : sys.links) {
      if (l.a != b && l.b != b) continue;
      if (l.kind != connect::JointKind::Prismatic && l.kind != connect::JointKind::Cylindrical) continue;
      if (std::abs(dot(l.axis, axis)) < kAxisAgree) continue;
      const Vec3 v = velocityAt(twistOf(f, l.a), l.point) - velocityAt(twistOf(f, l.b), l.point);
      if (std::abs(dot(v, l.axis)) > 1e-4) return true;
    }
    return false;
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
        // A rod slides in its cylinder just as well when it is the cylinder that moves.
        if (type == "slides" && slidesInPartner(f, p, axis)) return done(TruthResult::Hit, "against what it slides in");
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
      // First as the model stands, from the rates alone. A piece that only starts to move once
      // the driver has gone some way (an actuator's housing, square to its work at rest) shows
      // when the freedom is driven, so then that is done.
      auto works = [&](const System& in, const Mobility& m) {
        for (size_t fi = 0; fi < m.freedoms.size(); fi++) {
          const Freedom& f = m.freedoms[fi];
          if (!moves(f, driver)) continue;
          driven = true;
          size_t moved = static_cast<size_t>(std::count_if(movers.begin(), movers.end(), [&](int p) { return moves(f, p); }));
          bool stays = std::none_of(stayers.begin(), stayers.end(), [&](int p) { return moves(f, p); });
          if (moved == movers.size() && stays) return true;
          if (moved > 0 && moved < movers.size() && stays) {
            const bool turning = length(twistOf(f, body(driver)).angular) > 1e-6;
            Pose pose;
            auto movedIn = [&](int p) {
              const Xform& x = pose.body[body(p)];
              if (length(x.apply(at(p)) - at(p)) >= kMovedLdu) return true;
              for (Vec3 e : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}})
                if (length(x.r * e - e) >= kMovedTurn) return true;
              return false;
            };
            // A stretch at a time until everything listed has moved.
            for (int stretch = 0; stretch < kDriveStretches; stretch++) {
              pose = drive(in, m, fi, body(driver), (turning ? kDriveTurn : kDriveTravel) / kDriveStretches, stretch ? &pose : nullptr, kScoreStep);
              if (pose.body.size() != in.bodies) break;
              moved = static_cast<size_t>(std::count_if(movers.begin(), movers.end(), movedIn));
              stays = std::none_of(stayers.begin(), stayers.end(), movedIn);
              if (moved == movers.size() && stays) return true;
              if (!pose.converged) break;
            }
          }
          if (moved >= best) best = moved, disturbed = !stays;
        }
        return false;
      };
      if (works(sys, mob)) return done(TruthResult::Hit);
      // A function behind a selector works once the selector is shifted to it.
      for (size_t i = 0; i < shiftCount(); i++)
        if (!(*shifts)[i].turnsWith.empty() && works(shifted(sys, {(*shifts)[i]}), with(i))) return done(TruthResult::Hit, "with a selector shifted");
      if (!driven) return done(TruthResult::Missing, "nothing moves the driver");
      return done(TruthResult::Missing, text("the driver's freedom moves %.0f of %.0f listed pieces", static_cast<double>(best), static_cast<double>(movers.size())) + (disturbed ? ", and one that should stay" : ""));
    }
    if (type == "shifts") {
      const int ring = c.contains("ring") ? piece(c["ring"]) : -1;
      if (ring < 0 || !c.contains("gears") || !c["gears"].is_array()) return done(TruthResult::Unresolved, "ring or gears not found");
      size_t coupled = 0, listed = 0;
      for (const json& ref : c["gears"]) {
        const int gear = piece(ref);
        if (gear < 0) return done(TruthResult::Unresolved, "gear not found");
        listed++;
        for (size_t i = 0; i < shiftCount(); i++) {
          const Shift& sh = (*shifts)[i];
          if (sh.body == body(ring) && std::find(sh.turnsWith.begin(), sh.turnsWith.end(), body(gear)) != sh.turnsWith.end()) {
            coupled++;
            break;
          }
        }
      }
      if (coupled == listed) return done(TruthResult::Hit);
      return done(TruthResult::Missing, text("the ring couples %.0f of %.0f gears", static_cast<double>(coupled), static_cast<double>(listed)));
    }
    if (type == "shiftMode") {
      const int input = c.contains("input") ? piece(c["input"]) : -1, output = c.contains("output") ? piece(c["output"]) : -1;
      if (input < 0 || output < 0 || !c.contains("ratio")) return done(TruthResult::Unresolved, "input, output or ratio not found");
      // Turns of the input for each turn of the output, in each freedom that turns both.
      auto ratios = [&](const System& in, const Mobility& m) {
        std::vector<double> out;
        for (const Ratio& r : throughRatios(in, m, body(output), body(input)))
          if (std::abs(r.value) > 1e-9) out.push_back(std::abs(r.value));
        return out;
      };
      if (c["ratio"].is_null()) {
        const std::vector<double> rest = ratios(sys, mob);
        return rest.empty() ? done(TruthResult::Hit) : done(TruthResult::Missing, text("at rest the input turns %.3f times per turn of the output", rest.front()));
      }
      if (!c["ratio"].is_number()) return done(TruthResult::Unresolved, "ratio is not a number");
      const double want = c["ratio"].get<double>();
      std::string found;
      for (size_t i = 0; i < shiftCount(); i++) {
        if ((*shifts)[i].turnsWith.empty()) continue;
        for (double r : ratios(shifted(sys, {(*shifts)[i]}), with(i))) {
          if (std::abs(r - want) <= 0.002) return done(TruthResult::Hit);
          found += text(" %.3f", r);
        }
      }
      return done(TruthResult::Missing, found.empty() ? "no shift joins the input to the output" : "ratios found:" + found);
    }
    return done(TruthResult::NotScored);
  }
};

}  // namespace

TruthScore score(const Model& model, const connect::Graph& graph, const System& sys, const Mobility& mob, ldraw::PartCache& parts, const json& expected, const std::vector<Shift>* shifts) {
  TruthScore out;
  if (!expected.is_object() || !expected.contains("mechanisms") || !expected["mechanisms"].is_array() || sys.bodyOf.size() != model.pieces().size()) return out;
  Scorer scorer{model, graph, sys, mob, {}, kNear, shifts, {}};
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
