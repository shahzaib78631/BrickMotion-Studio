#include "bm/plan/timeline.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <numeric>
#include <unordered_map>
#include "bm/collide/world.h"
#include "bm/plan/legacy.h"
#include "bm/plan/tolerances.h"

namespace bm::plan {

double eased(Ease e, double u) {
  u = std::clamp(u, 0.0, 1.0);
  switch (e) {
    case Ease::Smooth: return u * u * u * (10 + u * (-15 + 6 * u));  // minimum jerk
    case Ease::Gentle: return -(std::cos(M_PI * u) - 1) / 2;
    case Ease::Soft: return u < 0.5 ? 16 * std::pow(u, 5) : 1 - std::pow(-2 * u + 2, 5) / 2;
    case Ease::Linear: return u;
  }
  return u;
}

bool parse(const std::string& n, Ease& out) {
  if (n == "smooth") return out = Ease::Smooth, true;
  if (n == "gentle") return out = Ease::Gentle, true;
  if (n == "soft") return out = Ease::Soft, true;
  if (n == "linear") return out = Ease::Linear, true;
  return false;
}

bool parse(const std::string& n, FlightShape& out) {
  if (n == "auto") return out = FlightShape::Auto, true;
  if (n == "web") return out = FlightShape::Web, true;
  if (n == "arc") return out = FlightShape::Arc, true;
  return false;
}

bool parse(const std::string& n, Planner& out) {
  if (n == "native") return out = Planner::Native, true;
  if (n == "legacy") return out = Planner::Legacy, true;
  return false;
}

Style styleOf(const std::filesystem::path& project) {
  Style style;
  std::ifstream in(project);
  if (!in || project.extension() != ".brickmotion") return style;
  const nlohmann::json j = nlohmann::json::parse(in, nullptr, false);
  if (j.is_discarded() || !j.is_object()) return style;
  auto text = [&](const nlohmann::json& o, const char* key) { return o.is_object() && o.contains(key) && o[key].is_string() ? o[key].get<std::string>() : std::string(); };
  const nlohmann::json video = j.contains("settings") && j["settings"].is_object() && j["settings"].contains("video") ? j["settings"]["video"] : nlohmann::json();
  staging::parse(text(video, "floorStyle"), style.floorStyle);
  staging::parse(text(video, "floorSort"), style.floorSort);
  staging::parse(text(video, "floorSides"), style.floorSides);
  staging::parse(text(video, "floorMatch"), style.floorMatch);
  if (video.is_object() && video.contains("floorAspect") && video["floorAspect"].is_number()) style.floorAspect = video["floorAspect"].get<double>();
  const nlohmann::json motion = j.contains("plan") && j["plan"].is_object() && j["plan"].contains("motion") ? j["plan"]["motion"] : nlohmann::json();
  parse(text(motion, "ease"), style.ease);
  auto number = [&](const char* key, double& out) {
    if (video.is_object() && video.contains(key) && video[key].is_number()) out = video[key].get<double>();
  };
  number("targetSeconds", style.targetSeconds);
  number("introSeconds", style.introSeconds);
  number("buildSeconds", style.buildSeconds);
  number("outroSeconds", style.outroSeconds);
  if (video.is_object() && video.contains("heroOrbit") && video["heroOrbit"].is_boolean()) style.heroOrbit = video["heroOrbit"].get<bool>();
  return style;
}

namespace {

using staging::kStud;

struct Quat {
  double w = 1, x = 0, y = 0, z = 0;
};

/// A proper rotation as a quaternion.
Quat quatOf(const Mat3& r) {
  const double* m = r.m;
  Quat q;
  const double tr = m[0] + m[4] + m[8];
  if (tr > 0) {
    const double s = std::sqrt(tr + 1) * 2;
    q = {0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s};
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const double s = std::sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = {(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s};
  } else if (m[4] > m[8]) {
    const double s = std::sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = {(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s};
  } else {
    const double s = std::sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = {(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s};
  }
  const double l = std::sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  return {q.w / l, q.x / l, q.y / l, q.z / l};
}

Mat3 matOf(Quat q) {
  const double w = q.w, x = q.x, y = q.y, z = q.z;
  Mat3 r;
  r.m[0] = 1 - 2 * (y * y + z * z), r.m[1] = 2 * (x * y - z * w), r.m[2] = 2 * (x * z + y * w);
  r.m[3] = 2 * (x * y + z * w), r.m[4] = 1 - 2 * (x * x + z * z), r.m[5] = 2 * (y * z - x * w);
  r.m[6] = 2 * (x * z - y * w), r.m[7] = 2 * (y * z + x * w), r.m[8] = 1 - 2 * (x * x + y * y);
  return r;
}

/// From `a` (u = 0) to no turn at all (u = 1), the short way.
Quat towardsNone(Quat a, double u) {
  if (a.w < 0) a = {-a.w, -a.x, -a.y, -a.z};
  const double c = std::clamp(a.w, -1.0, 1.0), angle = std::acos(c);
  if (angle < 1e-9) return {1, 0, 0, 0};
  const double s = std::sin(angle), ka = std::sin((1 - u) * angle) / s, kb = std::sin(u * angle) / s;
  return {ka * a.w + kb, ka * a.x, ka * a.y, ka * a.z};
}

Mat3 transposed(const Mat3& r) {
  Mat3 t;
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) t.m[i * 3 + j] = r.m[j * 3 + i];
  return t;
}

bool isIdentity(const Mat3& r, double tol = 1e-9) {
  for (int i = 0; i < 9; i++)
    if (std::abs(r.m[i] - Mat3::identity().m[i]) > tol) return false;
  return true;
}

/// The proper rotation in a placement, as the web factors it (src/anim/affineTransform.ts): what
/// is left (scale, mirror, shear) is the part's own shape, and it waits on the floor that way.
Mat3 rotationOf(const Mat3& r) {
  const Vec3 a{r.m[0], r.m[3], r.m[6]}, b{r.m[1], r.m[4], r.m[7]}, c{r.m[2], r.m[5], r.m[8]};
  const double la = length(a), det = dot(a, cross(b, c));
  if (la < 1e-8 || !(std::abs(det) > 1e-12)) return {};
  const Vec3 x = a * (1 / (la * (det < 0 ? -1 : 1)));
  const Vec3 by = b - x * dot(x, b);
  if (length(by) < 1e-8) return {};
  const Vec3 y = by * (1 / length(by)), z = cross(x, y);
  Mat3 out;
  out.m[0] = x.x, out.m[1] = y.x, out.m[2] = z.x;
  out.m[3] = x.y, out.m[4] = y.y, out.m[5] = z.y;
  out.m[6] = x.z, out.m[7] = y.z, out.m[8] = z.z;
  return out;
}

Mat3 yawY(double radians) {  // about LDraw's Y, as three.js's makeRotationY
  Mat3 r;
  const double c = std::cos(radians), s = std::sin(radians);
  r.m[0] = c, r.m[2] = s, r.m[6] = -s, r.m[8] = c;
  return r;
}

double up(Vec3 v) { return -v.y; }  ///< height: LDraw's -Y

/// The highest top of what stands on each cell of the floor (a height field, 2.5D).
struct Grid {
  double x0 = 0, z0 = 0, cell = 8;
  int nx = 1, nz = 1;
  std::vector<double> top;
  void shape(const Box& over) {
    x0 = over.min.x, z0 = over.min.z;
    nx = std::max(1, static_cast<int>(std::ceil((over.max.x - over.min.x) / cell)) + 1);
    nz = std::max(1, static_cast<int>(std::ceil((over.max.z - over.min.z) / cell)) + 1);
    clear();
  }
  void clear() { top.assign(static_cast<size_t>(nx) * static_cast<size_t>(nz), -std::numeric_limits<double>::infinity()); }
  int ix(double x) const { return std::clamp(static_cast<int>(std::floor((x - x0) / cell)), 0, nx - 1); }
  int iz(double z) const { return std::clamp(static_cast<int>(std::floor((z - z0) / cell)), 0, nz - 1); }
  void add(const Box& b) {
    if (b.empty()) return;
    const double h = -b.min.y;
    for (int i = ix(b.min.x); i <= ix(b.max.x); i++)
      for (int k = iz(b.min.z); k <= iz(b.max.z); k++) {
        double& t = top[static_cast<size_t>(k) * nx + i];
        t = std::max(t, h);
      }
  }
  /// The highest top within `r` of (x, z) (a square round it: never less).
  double maxNear(double x, double z, double r) const {
    double h = -std::numeric_limits<double>::infinity();
    for (int k = iz(z - r); k <= iz(z + r); k++)
      for (int i = ix(x - r); i <= ix(x + r); i++) h = std::max(h, top[static_cast<size_t>(k) * nx + i]);
    return h;
  }
  double highest() const {
    double h = -std::numeric_limits<double>::infinity();
    for (double t : top) h = std::max(h, t);
    return h;
  }
};

/// Where a flown flight is `t` frames after it starts: the distance along its route, the leg
/// it is on, and how far through that leg it is, eased.
struct Clock {
  double s = 0, e = 1;
  size_t phase = 0;
};
Clock clockAt(const Flight& f, double t) {
  Clock c;
  c.s = f.routeAt.back(), c.phase = f.phases.size() - 1;
  for (size_t k = 0; k < f.phases.size(); k++) {
    const Flight::Phase& ph = f.phases[k];
    if (t <= ph.start + ph.frames) {
      c.phase = k;
      c.e = eased(f.ease, ph.frames > 0 ? std::clamp((t - ph.start) / ph.frames, 0.0, 1.0) : 1);
      c.s = ph.from + (ph.to - ph.from) * c.e;
      break;
    }
  }
  return c;
}

/// A flown flight's motion at a distance along its route; `turn` >= 0: that much of its turn
/// done (else as `routeTurn` says there).
Xform routeMotion(const Flight& f, double s, double turn = -1) {
  const size_t k = std::min<size_t>(f.route.size() - 2, static_cast<size_t>(std::max<std::ptrdiff_t>(0, std::upper_bound(f.routeAt.begin(), f.routeAt.end(), s) - f.routeAt.begin() - 1)));
  const double span = f.routeAt[k + 1] - f.routeAt[k], w = span > 0 ? std::clamp((s - f.routeAt[k]) / span, 0.0, 1.0) : 1;
  const Vec3 c = f.route[k] + (f.route[k + 1] - f.route[k]) * w;
  Xform x;
  if (!isIdentity(f.turnFrom)) {
    double u;
    if (turn >= 0) u = turn;
    else if (f.routeTurn.size() == f.route.size()) u = f.routeTurn[k] + (f.routeTurn[k + 1] - f.routeTurn[k]) * w;
    else u = eased(Ease::Smooth, f.turnEnd > f.turnStart ? (s - f.turnStart) / (f.turnEnd - f.turnStart) : (s >= f.turnEnd ? 1 : 0));
    x.r = u >= 1 ? Mat3{} : u <= 0 ? f.turnFrom : matOf(towardsNone(quatOf(f.turnFrom), u));
  }
  x.t = c - x.r * f.pivot;
  return x;
}

/// A floor of the build: the model's, or a unit's own spot's.
struct Floor {
  std::vector<staging::Region> bands;
  staging::Footprint around;
  int parent = -1;  ///< the context the unit is built in
  int after = -1;   ///< a unit built on the same spot before: its floor fills once that one has gone
  int afterNode = -1;
  std::vector<int> items;  ///< nodes waiting on this floor, in play order
  std::vector<std::vector<int>> windows;
  std::vector<int> shownFrom;  ///< per window: the first node during whose flight it is shown
  std::vector<double> appear;  ///< per window: when (frames)
};

/// One flight while it is laid out.
struct Node {
  const Plan* plan = nullptr;
  uint32_t mi = 0;
  Flight f;
  int ctx = 0;      ///< the floor it waits on
  int own = -1;     ///< a unit's: the floor it is built on
  int order = 0;    ///< play order
  bool staged = false;  ///< waits on a floor (it flies, and is not a unit built on a spot)
  int window = -1;
  Xform carry;      ///< where the frame its motions are in stands (a unit's spot), in the model
  Xform floorWorld; ///< where it waits, in the model
};

}  // namespace

Timeline buildTimeline(const Model& model, ldraw::PartCache& parts, const Plan& plan, const Style& style, Vec3 down,
                       connect::ConnectorDb* connectors, connect::Graph* graph) {
  // The web's own planner, ported as it is. It needs the connector data to choose each way in;
  // without it there is nothing to reproduce, so the native planner answers instead.
  if (style.planner == Planner::Legacy && connectors && graph) return legacy::buildLegacyTimeline(model, parts, *connectors, *graph, plan, style, down);
  (void)down;  // the floor is LDraw's: -Y up
  Timeline out;
  if (plan.moves.empty()) return out;
  const auto& pieces = model.pieces();
  const size_t n = pieces.size();
  std::vector<Box> local(n), boxes(n);
  Box all;
  for (size_t i = 0; i < n; i++) {
    const auto mesh = model.mesh(pieces[i].part, parts);
    local[i] = mesh ? mesh->bounds : Box{};
    boxes[i] = local[i].transformed(pieces[i].world);
    all.merge(boxes[i]);
  }
  if (all.empty()) return out;
  const double fps = style.fps > 0 ? style.fps : 30;
  const double ground = all.max.y;  // the floor: the model's lowest point
  const staging::Footprint layout{all.min.x, all.min.z, all.max.x, all.max.z};
  auto boxOf = [&](const std::vector<uint32_t>& set) {
    Box b;
    for (uint32_t p : set) b.merge(boxes[p]);
    return b;
  };
  // Floor a set of pieces takes, tightly packed: each part's footprint plus a stud.
  auto padArea = [&](const std::vector<uint32_t>& set) {
    double sum = 0;
    for (uint32_t p : set) {
      const Box& b = local[p];
      if (b.empty()) continue;
      sum += (std::ceil((b.max.x - b.min.x) / kStud - 0.01) + 1) * (std::ceil((b.max.z - b.min.z) / kStud - 0.01) + 1);
    }
    return sum;
  };
  const double floorArea = staging::styleArea(style.floorStyle);
  auto initialBands = [&](const staging::Footprint& f, double area) {
    return style.floorStyle == staging::Style::CameraFrame ? staging::cameraFrameBands(f, area, style.floorSides, style.floorAspect) : staging::bandsAround(f, area, style.floorSides);
  };
  auto bandsBox = [&](const std::vector<staging::Region>& bands, Box b) {
    for (const staging::Region& r : bands) b.merge(Box{{r.x0 * kStud, ground - 24, r.z0 * kStud}, {(r.x0 + r.width) * kStud, ground, (r.z0 + r.depth) * kStud}});
    return b;
  };
  // Pieces placed straight into a plan's moves (not in a unit of its own).
  auto loose = [&](const Plan& p) {
    std::vector<uint32_t> set;
    for (const Move& m : p.moves)
      if (m.sub < 0) set.insert(set.end(), m.unit.pieces.begin(), m.unit.pieces.end());
    return set;
  };

  // --- 1. the flights in play order, each unit's floor on a spot of its own beside the model ---
  std::vector<Floor> ctxs(1);
  ctxs[0].bands = initialBands(layout, padArea(loose(plan)) * floorArea);
  ctxs[0].around = layout;
  Box scene = bandsBox(ctxs[0].bands, all);
  double sideRight = all.max.x;
  for (const staging::Region& r : ctxs[0].bands) sideRight = std::max(sideRight, (r.x0 + r.width) * kStud);
  std::vector<Node> nodes;
  std::vector<int> lastAtDepth;
  int counter = 0;
  std::function<void(const Plan&, uint32_t, int, int, Xform, uint32_t, int)> lay = [&](const Plan& p, uint32_t mi, int parent, int ctx, Xform carry, uint32_t top, int level) {
    const Move& m = p.moves[mi];
    const int self = static_cast<int>(nodes.size());
    nodes.emplace_back();
    {
      Node& node = nodes.back();
      node.plan = &p, node.mi = mi, node.ctx = ctx, node.carry = carry;
      Flight& f = node.f;
      f.move = top, f.parent = parent, f.depth = level, f.pieces = m.unit.pieces, f.flag = m.flag, f.insertion = m.insertion, f.seatTravel = m.seatTravel;
    }
    const Box box = boxOf(m.unit.pieces);
    const bool flies = flown(m.flag) && !m.path.empty() && !box.empty();
    if (flies && m.sub >= 0 && static_cast<size_t>(m.sub) < p.subs.size() && level < 8) {
      // Its own spot, right of everything so far, its own bands round it.
      const Plan& sub = p.subs[static_cast<size_t>(m.sub)];
      const double zMid = (all.min.z + all.max.z) / 2;
      Xform spot;
      spot.t = {sideRight + staging::kSideGap * kStud - box.min.x, ground - box.max.y, zMid - (box.min.z + box.max.z) / 2};
      auto footprintAt = [&](const Xform& s) {
        const Box b = box.transformed(s);
        return staging::Footprint{b.min.x, b.min.z, b.max.x, b.max.z};
      };
      const double area = padArea(loose(sub)) * floorArea;
      std::vector<staging::Region> bands = initialBands(footprintAt(spot), area);
      double edge = box.transformed(spot).min.x;
      for (const staging::Region& r : bands) edge = std::min(edge, r.x0 * kStud);
      const double shift = std::max(0.0, sideRight + staging::kSideGap * kStud - edge);
      if (shift > 0) spot.t.x += shift, bands = initialBands(footprintAt(spot), area);
      const Box focus = bandsBox(bands, box.transformed(spot));
      scene.merge(focus);
      const double savedRight = sideRight;
      sideRight = std::max(box.transformed(spot).max.x, focus.max.x);
      Floor c;
      c.bands = bands, c.around = footprintAt(spot), c.parent = ctx;
      if (static_cast<size_t>(level) < lastAtDepth.size() && lastAtDepth[static_cast<size_t>(level)] >= 0) {
        c.afterNode = lastAtDepth[static_cast<size_t>(level)];
        c.after = nodes[static_cast<size_t>(c.afterNode)].own;
      }
      const int own = static_cast<int>(ctxs.size());
      ctxs.push_back(std::move(c));
      nodes[static_cast<size_t>(self)].own = own;
      nodes[static_cast<size_t>(self)].floorWorld = spot;
      nodes[static_cast<size_t>(self)].f.staging = carry.inverse() * spot;
      for (uint32_t k = 0; k < sub.moves.size(); k++) lay(sub, k, self, own, spot, top, level + 1);
      sideRight = savedRight;
      if (lastAtDepth.size() <= static_cast<size_t>(level)) lastAtDepth.resize(static_cast<size_t>(level) + 1, -1);
      lastAtDepth[static_cast<size_t>(level)] = self;
    } else if (flies) {
      nodes[static_cast<size_t>(self)].staged = true;
    }
    nodes[static_cast<size_t>(self)].order = counter++;
  };
  for (uint32_t mi = 0; mi < plan.moves.size(); mi++) lay(plan, mi, -1, 0, Xform{}, mi, 0);
  {  // into play order: a unit after its own build
    std::vector<size_t> order(nodes.size());
    std::iota(order.begin(), order.end(), size_t{0});
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return nodes[a].order < nodes[b].order; });
    std::vector<int> at(order.size());
    for (size_t i = 0; i < order.size(); i++) at[order[i]] = static_cast<int>(i);
    std::vector<Node> sorted;
    for (size_t i : order) {
      Node nd = std::move(nodes[i]);
      if (nd.f.parent >= 0) nd.f.parent = at[static_cast<size_t>(nd.f.parent)];
      sorted.push_back(std::move(nd));
    }
    nodes = std::move(sorted);
    for (Floor& c : ctxs)
      if (c.afterNode >= 0) c.afterNode = at[static_cast<size_t>(c.afterNode)];
  }
  const size_t count = nodes.size();
  std::vector<int> unitNode(ctxs.size(), -1);  // the unit each floor builds
  for (size_t i = 0; i < count; i++) {
    if (nodes[i].own >= 0) unitNode[static_cast<size_t>(nodes[i].own)] = static_cast<int>(i);
    if (nodes[i].staged) ctxs[static_cast<size_t>(nodes[i].ctx)].items.push_back(static_cast<int>(i));
  }

  // --- 2. the floor: windows of pieces waiting, each turned its part's own way up ---
  std::vector<std::string> partNames;
  for (const Piece& p : pieces) partNames.push_back(p.part);
  std::sort(partNames.begin(), partNames.end());
  partNames.erase(std::unique(partNames.begin(), partNames.end()), partNames.end());
  auto partRank = [&](const std::string& part) { return static_cast<double>(std::lower_bound(partNames.begin(), partNames.end(), part) - partNames.begin()); };
  // How a staged node waits: turned to its part's own way up (one piece), as built (several).
  auto floorTurn = [&](const Node& nd) {
    const Move& m = nd.plan->moves[nd.mi];
    for (const Xform& x : m.path)
      if (!isIdentity(x.r)) return Mat3{};  // a path that turns: flown as the plan has it
    if (m.unit.pieces.size() != 1) return Mat3{};
    return transposed(rotationOf(pieces[m.unit.pieces[0]].world.r));
  };
  auto turnedBox = [&](const Node& nd, const Mat3& turn) {
    Box b;
    Xform x;
    x.r = turn;
    for (uint32_t p : nd.plan->moves[nd.mi].unit.pieces) b.merge(local[p].transformed(x * pieces[p].world));
    return b;
  };
  for (size_t ci = 0; ci < ctxs.size(); ci++) {
    Floor& c = ctxs[ci];
    if (c.items.empty()) continue;
    std::vector<staging::Item> items;
    std::unordered_map<uint32_t, int> colourOf;
    // Steps in this floor, in order, for grouping by step.
    std::vector<std::vector<int>> stepList;
    for (int ni : c.items) {
      const Node& nd = nodes[static_cast<size_t>(ni)];
      const uint32_t first = nd.plan->moves[nd.mi].unit.pieces.front();
      const std::vector<int> s = stepsOf(pieces[first]);
      if (std::find(stepList.begin(), stepList.end(), s) == stepList.end()) stepList.push_back(s);
    }
    for (int ni : c.items) {
      const Node& nd = nodes[static_cast<size_t>(ni)];
      const uint32_t first = nd.plan->moves[nd.mi].unit.pieces.front();
      const Box b = turnedBox(nd, floorTurn(nd));
      staging::Item it;
      it.id = static_cast<uint32_t>(ni);
      it.key = pieces[first].id;
      it.w = std::max(1, static_cast<int>(std::ceil((b.max.x - b.min.x) / kStud - 0.01)));
      it.d = std::max(1, static_cast<int>(std::ceil((b.max.z - b.min.z) / kStud - 0.01)));
      const int colour = pieces[first].color;
      switch (style.floorSort) {
        case staging::Sort::Step: it.group = static_cast<double>(std::find(stepList.begin(), stepList.end(), stepsOf(pieces[first])) - stepList.begin()); break;
        case staging::Sort::Colour: it.group = colour; break;
        case staging::Sort::Part: it.group = partRank(pieces[first].part); break;
        default: it.group = 0;
      }
      colourOf[it.id] = colour;
      items.push_back(std::move(it));
    }
    // Colour order within ties; layoutFloor keeps the caller's order.
    std::vector<staging::Item> ordered = items;
    std::stable_sort(ordered.begin(), ordered.end(), [&](const staging::Item& a, const staging::Item& b) { return a.group != b.group ? a.group < b.group : colourOf[a.id] < colourOf[b.id]; });
    std::unordered_map<uint32_t, std::vector<int>> prefer;
    const bool nearest = style.floorMatch == staging::Match::Nearest;
    if (nearest) {
      std::vector<std::pair<uint32_t, staging::Spot>> at;
      for (int ni : c.items) {
        const Node& nd = nodes[static_cast<size_t>(ni)];
        const Box b = boxOf(nd.plan->moves[nd.mi].unit.pieces).transformed(nd.carry);
        at.push_back({static_cast<uint32_t>(ni), {(b.min.x + b.max.x) / 2 / kStud, (b.min.z + b.max.z) / 2 / kStud}});
      }
      prefer = staging::bandPreference(at, c.bands);
    }
    const auto* pref = nearest ? &prefer : nullptr;
    if (style.floorSort == staging::Sort::All) {  // every piece on the floor from the start
      staging::Footprint around = c.around;
      if (ci != 0) {
        const Box bb = bandsBox(std::vector<staging::Region>(c.bands.begin() + 1, c.bands.end()), bandsBox({c.bands[0]}, Box{}));
        around = {bb.min.x, bb.min.z, bb.max.x, bb.max.z};
      }
      for (int tries = 0; tries < 8 && !staging::layoutBands(ordered, c.bands, style.floorStyle, pref, style.floorAspect).overflow.empty(); tries++)
        c.bands = staging::growBands(c.bands, around, 1.35, style.floorStyle == staging::Style::CameraFrame);
      scene = bandsBox(c.bands, scene);
    }
    std::vector<staging::Item> playOrdered = items;  // already in play order
    const std::vector<staging::Window> windows = staging::windowed(playOrdered, c.bands, style.floorStyle, pref, style.floorAspect);
    for (size_t wi = 0; wi < windows.size(); wi++) {
      const staging::Window& win = windows[wi];
      std::vector<staging::Item> mine;
      for (const staging::Item& it : ordered)
        if (std::find(win.ids.begin(), win.ids.end(), it.id) != win.ids.end()) mine.push_back(it);
      const staging::Layout again = staging::layoutBands(mine, c.bands, style.floorStyle, pref, style.floorAspect);
      const staging::Positions& pos = again.overflow.empty() ? again.pos : win.pos;
      c.windows.emplace_back();
      for (uint32_t id : win.ids) {
        Node& nd = nodes[id];
        nd.window = static_cast<int>(wi);
        c.windows.back().push_back(static_cast<int>(id));
        const Mat3 turn = floorTurn(nd);
        const Box b = turnedBox(nd, turn);
        const auto found = pos.find(id);
        const staging::Spot p = found != pos.end() ? found->second : staging::Spot{c.bands[0].x0, c.bands[0].z0};
        Xform floor;
        floor.r = turn;
        floor.t = {p.x * kStud - b.min.x, ground - b.max.y, p.z * kStud - b.min.z};
        if (style.floorStyle == staging::Style::Scattered) {  // a gentle, repeatable turn about its middle
          const double cx = p.x * kStud + (b.max.x - b.min.x) / 2, cz = p.z * kStud + (b.max.z - b.min.z) / 2;
          const double yaw = (staging::hash01(pieces[nd.plan->moves[nd.mi].unit.pieces.front()].id, 3) - 0.5) * (28 * M_PI / 180);
          Xform turnAbout;
          turnAbout.r = yawY(yaw);
          turnAbout.t = Vec3{cx, 0, cz} - turnAbout.r * Vec3{cx, 0, cz};
          floor = turnAbout * floor;
        }
        nd.floorWorld = floor;
        nd.f.staging = nd.carry.inverse() * floor;
        Box fb;
        for (uint32_t q : nd.plan->moves[nd.mi].unit.pieces) fb.merge(local[q].transformed(floor * pieces[q].world));
        scene.merge(fb);
      }
    }
  }
  // When each window is shown, by node: the last piece of the window before has lifted.
  for (size_t ci = 0; ci < ctxs.size(); ci++) {
    Floor& c = ctxs[ci];
    for (size_t wi = 0; wi < c.windows.size(); wi++) {
      int from = 0;
      if (wi > 0) from = c.windows[wi - 1].empty() ? 0 : *std::max_element(c.windows[wi - 1].begin(), c.windows[wi - 1].end());
      else {
        if (c.afterNode >= 0) from = c.afterNode + 1;
        if (c.parent >= 0 && !ctxs[static_cast<size_t>(c.parent)].shownFrom.empty()) from = std::max(from, ctxs[static_cast<size_t>(c.parent)].shownFrom[0]);
      }
      c.shownFrom.push_back(from);
    }
    c.appear.assign(c.windows.size(), 0);
  }

  // --- 3. each flight's way through the air, in play order, round what stands then ---
  collide::ShapeCache shapes;
  const collide::World world(model, parts, shapes);
  scene.min = scene.min - Vec3{400, 400, 400}, scene.max = scene.max + Vec3{400, 400, 400};
  Grid built, temp;  // into the model, and everything else (the floor, units on their spots)
  built.shape(scene), temp.shape(scene);
  std::vector<uint8_t> builtPresent(n, 0), onSpot(n, 0), landed(count, 0);
  std::vector<Xform> worldOf(n);  // each piece's motion in the model now
  std::vector<int> staticNode(n, -1);
  for (size_t i = 0; i < count; i++)
    if (nodes[i].staged)
      for (uint32_t p : nodes[i].plan->moves[nodes[i].mi].unit.pieces) worldOf[p] = nodes[i].floorWorld, staticNode[p] = static_cast<int>(i);
  struct Obstacle {
    uint32_t piece;
    Xform pose;
    Box box;
  };
  std::vector<Obstacle> tempList;
  bool tempDirty = true;
  auto shownFloor = [&](int node, size_t now) {
    const Node& nd = nodes[static_cast<size_t>(node)];
    if (!nd.staged || nd.window < 0) return false;
    return static_cast<size_t>(ctxs[static_cast<size_t>(nd.ctx)].shownFrom[static_cast<size_t>(nd.window)]) <= now;
  };
  auto rebuildTemp = [&](size_t now) {
    temp.clear(), tempList.clear();
    for (uint32_t p = 0; p < n; p++) {
      bool in = onSpot[p] != 0;
      if (!in && staticNode[p] >= 0 && !landed[static_cast<size_t>(staticNode[p])] && shownFloor(staticNode[p], now)) in = true;
      if (!in || local[p].empty()) continue;
      const Xform pose = worldOf[p] * pieces[p].world;
      const Box b = local[p].transformed(pose);
      temp.add(b);
      tempList.push_back({p, pose, b});
    }
    tempDirty = false;
  };
  std::vector<uint8_t> shownBefore(count, 0);
  // Pacing, as the web's one by one: each flight 0.85 of a piece's slot, 0.35 s to 0.9 s, and a
  // pause at each step. With a length set, the slot is the build's share of it.
  int flyingUnits = 0, stepCount = 0;
  {
    std::vector<int> last;
    for (size_t i = 0; i < count; i++) {
      const Node& nd = nodes[i];
      const Move& m = nd.plan->moves[nd.mi];
      if (!flown(m.flag) || m.path.empty() || boxOf(m.unit.pieces).empty()) continue;
      flyingUnits++;
      if (nd.own >= 0) continue;
      const std::vector<int> key = stepsOf(pieces[m.unit.pieces.front()]);
      if (stepCount == 0 || key != last) stepCount++;
      last = key;
    }
  }
  double flightSeconds = std::clamp(0.85 / std::max(0.01, style.piecesPerSecond), 0.35, 0.9), webPause = -1;
  if (style.targetSeconds > 0) {
    const double intro = std::clamp(style.introSeconds >= 0 ? style.introSeconds : 1.0, 0.2, 120.0);
    const double outro = std::clamp(style.outroSeconds >= 0 ? style.outroSeconds : (style.heroOrbit ? 3.0 : 0.5), 0.2, 120.0);
    const double base = std::max(1.0, style.buildSeconds >= 0 ? style.buildSeconds : style.targetSeconds - intro - outro);
    const double pauseTotal = stepCount > 1 ? std::min(0.25 * (stepCount - 1), 0.2 * base) : 0;
    const double slot = flyingUnits > 0 ? (base - pauseTotal) / flyingUnits : base - pauseTotal;
    flightSeconds = std::clamp(slot * 0.85, 0.35, 0.9);
    webPause = stepCount > 1 ? pauseTotal / (stepCount - 1) : 0;
  }
  // Each flight's timing in seconds first, then laid out in frames.
  for (size_t i = 0; i < count; i++) {
    Node& nd = nodes[i];
    Flight& f = nd.f;
    const Move& m = nd.plan->moves[nd.mi];
    const std::vector<uint32_t>& unit = m.unit.pieces;
    // A window shown from this flight on, or a unit gone from its spot: what stands has changed.
    for (const Floor& c : ctxs)
      for (int from : c.shownFrom)
        if (static_cast<size_t>(from) == i) tempDirty = true;
    if (tempDirty) rebuildTemp(i);
    const bool flies = flown(m.flag) && !m.path.empty() && !boxOf(unit).empty();
    if (flies) {
      bool turnsInPath = false;
      for (const Xform& x : m.path) turnsInPath = turnsInPath || !isIdentity(x.r);
      const Box seatBox = boxOf(unit);
      const Vec3 pivot = (seatBox.min + seatBox.max) * 0.5;
      const Xform& carry = nd.carry;
      const Xform floorWorld = nd.floorWorld;
      const Mat3 r0 = (carry.inverse() * floorWorld).r;
      const bool turning = !isIdentity(r0);
      const double r3 = 0.5 * length(seatBox.max - seatBox.min);
      const double rh = 0.5 * std::hypot(seatBox.max.x - seatBox.min.x, seatBox.max.z - seatBox.min.z);
      const double below = seatBox.max.y - pivot.y;
      const Vec3 S = floorWorld.apply(pivot);
      std::vector<Vec3> P;
      for (const Xform& x : m.path) P.push_back(carry.apply(x.apply(pivot)));
      const size_t np = P.size();
      const double groundUp = -ground;
      auto standing = [&](double x, double z, double r) { return std::max({built.maxNear(x, z, r), temp.maxNear(x, z, r), groundUp}); };
      // The leg into the seat: the last of the plan's way, as long as it needs to slide.
      Vec3 seatFrom = P[0];
      if (np >= 2) {
        const Vec3 d = P[1] - P[0];
        const double len = length(d);
        if (len > 1e-9) seatFrom = P[0] + d * (std::min(len, std::max(f.seatTravel, 4.0) + 8) / len);
      }
      const Vec3 dOut = np >= 2 ? normalized(P[np - 1] - P[np - 2]) : Vec3{0, -1, 0};
      f.exitsBelow = dOut.y > 1e-6;
      const bool vertical = dot(dOut, Vec3{0, -1, 0}) > 1 - 1e-6;  // straight up: come down onto it anywhere
      // Where it joins the plan's way: on a way out straight up, as low as what stands round it
      // lets it; otherwise the way's far end, or further out along it, where nothing stands above.
      Vec3 J = np >= 2 ? P[np - 1] : P[0] + Vec3{0, -(std::max(f.seatTravel, 4.0) + 40), 0};
      bool extended = false, joinInside = false;
      if (np >= 2 && vertical) {
        const double need = standing(J.x, J.z, rh) + kClearMargin + below;
        const Vec3 inner = np == 2 ? seatFrom : P[np - 2];
        const double low = up(inner), high = up(P[np - 1]);
        const double t = high > low ? (std::clamp(need, low, high) - low) / (high - low) : 1;
        J = inner + (P[np - 1] - inner) * t;  // on the leg
      } else if (np >= 2) {
        // The nearest point of the way out with nothing above it: the plan's way is long, and
        // its far end can lie out among the pieces waiting on the floor.
        bool found = false;
        auto columnClear = [&](Vec3 v) { return standing(v.x, v.z, rh) + kClearMargin + below <= up(v); };
        // Exactly: the unit, turned as in its seat, lowered straight down onto `v` from above
        // everything round it, against each piece that stands there.
        const Vec3 seatPivot = carry.apply(pivot);
        std::vector<uint32_t> nearBy;
        auto columnExact = [&](Vec3 v) {
          const double topH = standing(v.x, v.z, rh) + kClearMargin + below;
          if (topH <= up(v)) return true;
          for (double h = 0; h <= topH - up(v) + collide::kSweepStep; h += collide::kSweepStep) {
            Xform move;
            move.t = v - seatPivot + Vec3{0, -h, 0};
            for (uint32_t p : unit) {
              if (local[p].empty()) continue;
              const Xform pose = move * carry * pieces[p].world;
              const Box b = local[p].transformed(pose);
              nearBy.clear();
              world.near(b, &builtPresent, nearBy);
              for (uint32_t q : nearBy)
                if (collide::overlap(world.shape(p), pose, world.shape(q), world.pose(q))) return false;
              for (const Obstacle& o : tempList) {
                if (std::binary_search(unit.begin(), unit.end(), o.piece)) continue;
                if (!onSpot[o.piece] && staticNode[o.piece] >= 0 && landed[static_cast<size_t>(staticNode[o.piece])]) continue;
                if (o.box.min.x > b.max.x || b.min.x > o.box.max.x || o.box.min.y > b.max.y || b.min.y > o.box.max.y || o.box.min.z > b.max.z || b.min.z > o.box.max.z) continue;
                if (collide::overlap(world.shape(p), pose, world.shape(o.piece), o.pose)) return false;
              }
            }
          }
          return true;
        };
        const Vec3 inner = np == 2 ? seatFrom : P[np - 2];
        const double legLength = length(P[np - 1] - inner);
        for (double g = 0; g <= legLength + 1e-9 && !found; g += 4) {
          const Vec3 v = inner + dOut * std::min(g, legLength);
          if (columnClear(v)) J = v, found = true;
        }
        for (double g = 0; g <= legLength + 1e-9 && !found; g += 8) {  // what the floor's grid is too coarse to tell
          const Vec3 v = inner + dOut * std::min(g, legLength);
          if (columnExact(v)) J = v, found = true;
        }
        joinInside = found;
        for (double e = 20; e <= 600 && !found; e += 20) {
          const Vec3 j = P[np - 1] + dOut * e;
          if (up(j) - below < groundUp) break;
          if (columnClear(j) || columnExact(j)) J = j, extended = true, found = true;
        }
        if (!found) f.fallback = true, f.fallbackAt = 1;
      }
      // The way across: from above the floor spot to above the join, just over what stands.
      const double ax = S.x, az = S.z, bx = J.x, bz = J.z;
      const double X = std::hypot(bx - ax, bz - az);
      const Vec3 dir = X > 1e-9 ? Vec3{(bx - ax) / X, 0, (bz - az) / X} : Vec3{};
      const int N = std::clamp(static_cast<int>(std::ceil(X / 8)), 1, 240);
      const double dx = X / N;
      auto at3 = [&](double x, double h) { return Vec3{ax + dir.x * x, -h, az + dir.z * x}; };
      // As the web's flight (src/anim/timeline.ts flightPose): straight up off the floor, level
      // across, turning on the way by the crossing's own clock, and straight down onto the plan's
      // way. Each sample of the way across is sized by the unit over the share of its turn done
      // round it (all of it, where it turns in place).
      const Quat q0 = quatOf(r0);
      auto turnAt = [&](double x) { return turning ? (X > 1e-9 ? std::clamp(x / X, 0.0, 1.0) : 1.0) : 1.0; };
      std::vector<double> reach(static_cast<size_t>(N) + 1), drop(static_cast<size_t>(N) + 1);  // how far out, and down, the unit reaches from its pivot
      for (int k = 0; k <= N; k++) {
        const double ua = turning ? (X > 1e-9 ? turnAt((k - 1) * dx) : 0.0) : 1.0, ub = turnAt((k + 1) * dx);
        double out = 0, dn = 0;
        for (int j = 0; j <= (turning ? 8 : 0); j++) {
          const double u = turning ? ua + (ub - ua) * j / 8 : 1.0;
          const Mat3 R = u >= 1 ? Mat3{} : matOf(towardsNone(q0, u));
          for (int c = 0; c < 8; c++) {
            const Vec3 corner = R * (Vec3{c & 1 ? seatBox.max.x : seatBox.min.x, c & 2 ? seatBox.max.y : seatBox.min.y, c & 4 ? seatBox.max.z : seatBox.min.z} - pivot);
            out = std::max(out, std::hypot(corner.x, corner.z)), dn = std::max(dn, corner.y);
          }
        }
        reach[static_cast<size_t>(k)] = out, drop[static_cast<size_t>(k)] = dn;
      }
      const double deepest = *std::max_element(drop.begin(), drop.end());
      // The height across, as the web's skyY: level, at `level`. The caller chooses the lowest one
      // the exact check accepts: the height field is sampled with the whole of the unit's turn
      // reach, so the height it reports overstates what is in the way.
      auto buildRoute = [&](bool direct, Vec3 join, bool arc, double level, std::vector<Vec3>& route, std::vector<double>& turn, double& sLift, double& sCruise, double& sJoin, double& sEntry, double& sSeat) {
        route.clear(), turn.clear();
        route.push_back(S), turn.push_back(turning ? 0.0 : 1.0);
        double s = 0;
        auto addS = [&](Vec3 v, double u) {
          if (length(v - route.back()) <= 1e-6) return;
          s += length(v - route.back());
          route.push_back(v), turn.push_back(u);
        };
        if (direct) {
          // Carried straight to its own way in, turning to its seat's way on the way: it is
          // already facing the seat when it starts to slide in.
          sLift = 0, sCruise = 0;
          addS(join, 1);
          sJoin = s;
        } else {
          // Arc: the corner from up to across rounded (a quadratic, about a point an LDU), so the
          // sweep up and over never stops; it may cut under `level`, which the check sees.
          const double rc = arc ? std::min({style.corner, 0.5 * (level - up(S)), 0.5 * X}) : 0.0;
          if (rc > 1e-6) {
            addS(at3(0, level - rc), turning ? 0.0 : 1.0);
            const int pts = std::max(2, static_cast<int>(std::ceil(rc)));
            for (int j = 1; j <= pts; j++) {
              const double u = static_cast<double>(j) / pts;
              addS(at3(rc * u * u, (level - rc) * (1 - u) * (1 - u) + level * (2 * u * (1 - u) + u * u)), turning ? 0.0 : 1.0);
            }
          } else {
            addS(at3(0, level), turning ? 0.0 : 1.0);
          }
          sLift = s;
          addS(at3(X, level), 1);
          sCruise = s;
          addS(join, 1);
          sJoin = s;
        }
        // Then the plan's own way, from the join. A direct carry joins it at (or beyond) its far
        // end, so the whole way in is flown; the web's may join it partway along.
        sEntry = sJoin;
        if (direct ? dot(join - P[np - 1], dOut) > 1e-6 : extended) {
          addS(P[np - 1], 1);
          sEntry = s;
        }
        for (size_t k = np >= 2 ? np - 2 : 0; k >= 1; k--) {
          if (!direct && ((vertical && up(P[k]) > up(join) + 1e-9) || (joinInside && k == np - 1))) continue;  // beyond the join: not flown
          addS(P[k], 1);
        }
        sSeat = s;
        if (length(seatFrom - P[0]) > 1e-9) {
          addS(seatFrom, 1);
          sSeat = s;
        }
        addS(P[0], 1);
      };
      // Checks the way across and into the seat exactly, as it will be played: each piece against
      // what stands then (both built pieces up to the plan's own way and pieces waiting on the floor).
      bool arc = false, direct = false;
      const Vec3 seatPivot = carry.apply(pivot);
      double unitRadius = 0;
      for (uint32_t p : unit) {
        if (local[p].empty()) continue;
        const Box pb = local[p].transformed(carry * pieces[p].world);
        for (int c = 0; c < 8; c++)
          unitRadius = std::max(unitRadius, length(Vec3{c & 1 ? pb.max.x : pb.min.x, c & 2 ? pb.max.y : pb.min.y, c & 4 ? pb.max.z : pb.min.z} - seatPivot));
      }
      unitRadius += 2.0;
      struct NearObstacle {
        Box box;
        uint32_t piece;
        Xform pose;
      };
      std::vector<NearObstacle> nearBuilt, nearTemp;
      auto clearAt = [&](const Flight& trial, double s, double u, bool checkBuilt, collide::Depth depth) {
        if (nearBuilt.empty() && nearTemp.empty()) return true;
        // Quick sphere-box reject around the pivot position at s before transforming every piece.
        const size_t k = std::min<size_t>(trial.route.size() - 2,
          static_cast<size_t>(std::max<std::ptrdiff_t>(0, std::upper_bound(trial.routeAt.begin(), trial.routeAt.end(), s) - trial.routeAt.begin() - 1)));
        const double span = trial.routeAt[k + 1] - trial.routeAt[k], w = span > 0 ? std::clamp((s - trial.routeAt[k]) / span, 0.0, 1.0) : 1;
        const Vec3 c = trial.route[k] + (trial.route[k + 1] - trial.route[k]) * w;
        const Box sphere{c - Vec3{unitRadius, unitRadius, unitRadius}, c + Vec3{unitRadius, unitRadius, unitRadius}};
        bool anyBuilt = false, anyTemp = false;
        if (checkBuilt)
          for (const NearObstacle& o : nearBuilt) {
            if (o.box.min.x > sphere.max.x) break;
            if (sphere.min.x <= o.box.max.x && o.box.min.y <= sphere.max.y && sphere.min.y <= o.box.max.y && o.box.min.z <= sphere.max.z && sphere.min.z <= o.box.max.z) {
              anyBuilt = true;
              break;
            }
          }
        for (const NearObstacle& o : nearTemp) {
          if (o.box.min.x > sphere.max.x) break;
          if (sphere.min.x <= o.box.max.x && o.box.min.y <= sphere.max.y && sphere.min.y <= o.box.max.y && o.box.min.z <= sphere.max.z && sphere.min.z <= o.box.max.z) {
            anyTemp = true;
            break;
          }
        }
        if (!anyBuilt && !anyTemp) return true;
        const Xform motion = routeMotion(trial, s, u);
        if (unit.size() > 1) {
          const Box ub = seatBox.transformed(motion * carry);
          if (anyBuilt) {
            anyBuilt = false;
            for (const NearObstacle& o : nearBuilt) {
              if (o.box.min.x > ub.max.x) break;
              if (ub.min.x <= o.box.max.x && o.box.min.y <= ub.max.y && ub.min.y <= o.box.max.y && o.box.min.z <= ub.max.z && ub.min.z <= o.box.max.z) {
                anyBuilt = true;
                break;
              }
            }
          }
          if (anyTemp) {
            anyTemp = false;
            for (const NearObstacle& o : nearTemp) {
              if (o.box.min.x > ub.max.x) break;
              if (ub.min.x <= o.box.max.x && o.box.min.y <= ub.max.y && ub.min.y <= o.box.max.y && o.box.min.z <= ub.max.z && ub.min.z <= o.box.max.z) {
                anyTemp = true;
                break;
              }
            }
          }
          if (!anyBuilt && !anyTemp) return true;
        }
        for (uint32_t p : unit) {
          if (local[p].empty()) continue;
          const Xform pose = motion * carry * pieces[p].world;
          const Box b = local[p].transformed(pose);
          if (anyBuilt)
            for (const NearObstacle& o : nearBuilt) {
              if (o.box.min.x > b.max.x) break;
              if (b.min.x > o.box.max.x || o.box.min.y > b.max.y || b.min.y > o.box.max.y || o.box.min.z > b.max.z || b.min.z > o.box.max.z) continue;
              if (collide::overlap(world.shape(p), pose, world.shape(o.piece), o.pose, {}, nullptr, depth)) return false;
            }
          if (anyTemp)
            for (const NearObstacle& o : nearTemp) {
              if (o.box.min.x > b.max.x) break;
              if (b.min.x > o.box.max.x || o.box.min.y > b.max.y || b.min.y > o.box.max.y || o.box.min.z > b.max.z || b.min.z > o.box.max.z) continue;
              if (collide::overlap(world.shape(p), pose, world.shape(o.piece), o.pose, {}, nullptr, depth)) return false;
            }
        }
        return true;
      };
      // Check how far down along the plan's path (from P[np - 1] to seatFrom) any floor obstacle
      // in tempList could possibly reach, so we only sample inside the plan's path when a floor
      // obstacle actually overlaps that corridor. Since on the plan's path the unit has finished
      // turning (r = I), its AABB around any point v in P is seatBox.transformed(carry) + (v - seatPivot).
      const Box unitCarryBox = seatBox.transformed(carry);
      const Vec3 unitMinOff = unitCarryBox.min - seatPivot - Vec3{1, 1, 1}, unitMaxOff = unitCarryBox.max - seatPivot + Vec3{1, 1, 1};
      Box planCorridor;
      for (const Vec3& v : P) {
        planCorridor.grow(v + unitMinOff);
        planCorridor.grow(v + unitMaxOff);
      }
      bool tempInPlanCorridor = false;
      for (const Obstacle& o : tempList) {
        if (std::binary_search(unit.begin(), unit.end(), o.piece)) continue;
        if (!onSpot[o.piece] && staticNode[o.piece] >= 0 && landed[static_cast<size_t>(staticNode[o.piece])]) continue;
        if (o.box.min.x > planCorridor.max.x || planCorridor.min.x > o.box.max.x || o.box.min.y > planCorridor.max.y || planCorridor.min.y > o.box.max.y || o.box.min.z > planCorridor.max.z || planCorridor.min.z > o.box.max.z) continue;
        tempInPlanCorridor = true;
        break;
      }
      std::vector<uint32_t> rawNearBuilt;
      auto clearAcross = [&](const Flight& trial, double sLift, double sCruise, double sJoin, double sEntry, double sSeat) {
        const double sCheck = std::max(sEntry, tempInPlanCorridor ? sSeat : sEntry);
        Box swept;
        for (size_t k = 0; k < trial.route.size(); k++) {
          const Vec3& v = trial.route[k];
          swept.grow(v - Vec3{unitRadius, unitRadius, unitRadius});
          swept.grow(v + Vec3{unitRadius, unitRadius, unitRadius});
          if (k < trial.routeAt.size() && trial.routeAt[k] >= sCheck - 1e-6) break;
        }
        rawNearBuilt.clear();
        world.near(swept, &builtPresent, rawNearBuilt);
        nearBuilt.clear();
        for (uint32_t q : rawNearBuilt) {
          if (std::binary_search(unit.begin(), unit.end(), q)) continue;
          nearBuilt.push_back({world.box(q), q, world.pose(q)});
        }
        std::sort(nearBuilt.begin(), nearBuilt.end(), [](const NearObstacle& a, const NearObstacle& b) { return a.box.min.x < b.box.min.x; });
        nearTemp.clear();
        for (const Obstacle& o : tempList) {
          if (std::binary_search(unit.begin(), unit.end(), o.piece)) continue;
          if (!onSpot[o.piece] && staticNode[o.piece] >= 0 && landed[static_cast<size_t>(staticNode[o.piece])]) continue;
          if (o.box.min.x > swept.max.x || swept.min.x > o.box.max.x || o.box.min.y > swept.max.y || swept.min.y > o.box.max.y || o.box.min.z > swept.max.z || swept.min.z > o.box.max.z) continue;
          nearTemp.push_back({o.box, o.piece, o.pose});
        }
        std::sort(nearTemp.begin(), nearTemp.end(), [](const NearObstacle& a, const NearObstacle& b) { return a.box.min.x < b.box.min.x; });
        const double step = collide::kSweepStep;  // as finely as the strict check looks
        double turned = 0;  // how far a corner of the unit sweeps in turning, at most
        if (turning) turned = r3 * 2 * std::acos(std::clamp(std::abs(q0.w), 0.0, 1.0));
        // How much of its turn the route has done at a distance, exactly as it is played
        // (routeMotion): a phase maps eased time straight onto distance, so by-distance is right.
        auto turnOf = [&](double s) {
          if (!turning || trial.routeTurn.size() != trial.route.size() || trial.route.size() < 2) return 1.0;
          const size_t k = std::min<size_t>(trial.route.size() - 2,
            static_cast<size_t>(std::max<std::ptrdiff_t>(0, std::upper_bound(trial.routeAt.begin(), trial.routeAt.end(), s) - trial.routeAt.begin() - 1)));
          const double span = trial.routeAt[k + 1] - trial.routeAt[k], w = span > 0 ? std::clamp((s - trial.routeAt[k]) / span, 0.0, 1.0) : 1;
          return trial.routeTurn[k] + (trial.routeTurn[k + 1] - trial.routeTurn[k]) * w;
        };
        // A non-turning straight segment has constant orientation (r = I when u >= 1, r = r0 when u <= 0)
        // and translates linearly. When its segment AABB does not intersect any obstacle box in
        // nearBuilt or nearTemp, every sample on that segment is guaranteed clear without per-sample work.
        std::vector<uint8_t> segmentHasObstacle(trial.route.size() >= 2 ? trial.route.size() - 1 : 0, 1);
        for (size_t seg = 0; seg + 1 < trial.route.size(); seg++) {
          if (trial.routeAt[seg] > sCheck + 1e-6) {
            segmentHasObstacle[seg] = 0;
            continue;
          }
          const double u0 = turnOf(trial.routeAt[seg]), u1 = turnOf(trial.routeAt[seg + 1]);
          if (turning && !((u0 <= 1e-9 && u1 <= 1e-9) || (u0 >= 1 - 1e-9 && u1 >= 1 - 1e-9))) continue;
          Box segBox;
          if (!turning || (u0 >= 1 - 1e-9 && u1 >= 1 - 1e-9)) {
            segBox = {
              {std::min(trial.route[seg].x, trial.route[seg + 1].x) + unitMinOff.x, std::min(trial.route[seg].y, trial.route[seg + 1].y) + unitMinOff.y, std::min(trial.route[seg].z, trial.route[seg + 1].z) + unitMinOff.z},
              {std::max(trial.route[seg].x, trial.route[seg + 1].x) + unitMaxOff.x, std::max(trial.route[seg].y, trial.route[seg + 1].y) + unitMaxOff.y, std::max(trial.route[seg].z, trial.route[seg + 1].z) + unitMaxOff.z}
            };
          } else {
            segBox = {
              {std::min(trial.route[seg].x, trial.route[seg + 1].x) - unitRadius, std::min(trial.route[seg].y, trial.route[seg + 1].y) - unitRadius, std::min(trial.route[seg].z, trial.route[seg + 1].z) - unitRadius},
              {std::max(trial.route[seg].x, trial.route[seg + 1].x) + unitRadius, std::max(trial.route[seg].y, trial.route[seg + 1].y) + unitRadius, std::max(trial.route[seg].z, trial.route[seg + 1].z) + unitRadius}
            };
          }
          bool hitBox = false;
          if (trial.routeAt[seg] <= sEntry + 1e-6)
            for (const NearObstacle& o : nearBuilt) {
              if (o.box.min.x > segBox.max.x) break;
              if (segBox.min.x <= o.box.max.x && o.box.min.y <= segBox.max.y && segBox.min.y <= o.box.max.y && o.box.min.z <= segBox.max.z && segBox.min.z <= o.box.max.z) {
                hitBox = true;
                break;
              }
            }
          if (!hitBox)
            for (const NearObstacle& o : nearTemp) {
              if (o.box.min.x > segBox.max.x) break;
              if (segBox.min.x <= o.box.max.x && o.box.min.y <= segBox.max.y && segBox.min.y <= o.box.max.y && o.box.min.z <= segBox.max.z && segBox.min.z <= o.box.max.z) {
                hitBox = true;
                break;
              }
            }
          if (!hitBox) segmentHasObstacle[seg] = 0;
        }
        auto segOf = [&](double s) {
          return std::min<size_t>(trial.route.size() - 2,
            static_cast<size_t>(std::max<std::ptrdiff_t>(0, std::upper_bound(trial.routeAt.begin(), trial.routeAt.end(), s) - trial.routeAt.begin() - 1)));
        };
        const int samples = std::max(2, static_cast<int>(std::ceil((sCheck + turned) / step)));
        // Sample endpoints and middle first, then coarse stride 16, then remaining samples, so
        // blocked routes fail in a handful of probes instead of hundreds.
        for (int k : {0, samples, samples / 2}) {
          const double s = sCheck * k / samples;
          if (!segmentHasObstacle[segOf(s)]) continue;
          const bool checkBuilt = s <= sEntry + 1e-6;
          const collide::Depth depth = (k > 0 && s < sJoin - 1e-6) ? collide::Depth::Outer : collide::Depth::Skin;
          if (!clearAt(trial, s, turnOf(s), checkBuilt, depth)) return false;
        }
        for (int k = 16; k < samples; k += 16) {
          if (k == samples / 2) continue;
          const double s = sCheck * k / samples;
          if (!segmentHasObstacle[segOf(s)]) continue;
          const bool checkBuilt = s <= sEntry + 1e-6;
          const collide::Depth depth = (k > 0 && s < sJoin - 1e-6) ? collide::Depth::Outer : collide::Depth::Skin;
          if (!clearAt(trial, s, turnOf(s), checkBuilt, depth)) return false;
        }
        for (int k = 1; k < samples; k++) {
          if (k == samples / 2 || (k & 15) == 0) continue;
          const double s = sCheck * k / samples;
          if (!segmentHasObstacle[segOf(s)]) continue;
          const bool checkBuilt = s <= sEntry + 1e-6;
          const collide::Depth depth = (k > 0 && s < sJoin - 1e-6) ? collide::Depth::Outer : collide::Depth::Skin;
          if (!clearAt(trial, s, turnOf(s), checkBuilt, depth)) return false;
        }
        if (!direct && turning && sCruise - sLift <= 1e-6) {  // it turns where it stands, up there
          const int turns = std::max(2, static_cast<int>(std::ceil(turned / step)));
          for (int k = 0; k <= turns; k++)
            if (!clearAt(trial, sLift, static_cast<double>(k) / turns, true, collide::Depth::Outer)) return false;
        }
        // Only once the discrete sample check passes, verify any non-turning direct transit (or
        // extended leg into the plan's far end) continuously with clearTravel so playedPath in
        // certifyPlay can never see a narrow graze between samples.
        if (nd.f.parent < 0 && !nearBuilt.empty()) {
          if (direct && !turning && sJoin > 1e-6) {
            const Vec3 stepVec = trial.route[1] - trial.route[0];
            const double len = length(stepVec);
            if (len > 1e-6) {
              Xform from;
              from.t = trial.route[0] - seatPivot;
              uint32_t hit = UINT32_MAX;
              if (world.clearTravel(unit, stepVec * (1 / len), len, &builtPresent, {}, &hit, from, 0.05, len - kTravelTol) < len - kTravelTol) return false;
            }
          }
          if (sEntry > sJoin + 1e-6 && trial.route.size() >= 3) {
            const size_t kJoin = direct ? 1 : (trial.route.size() - np);
            if (kJoin + 1 < trial.route.size()) {
              const Vec3 stepVec = trial.route[kJoin + 1] - trial.route[kJoin];
              const double len = length(stepVec);
              if (len > 1e-6) {
                Xform from;
                from.t = trial.route[kJoin] - seatPivot;
                uint32_t hit = UINT32_MAX;
                if (world.clearTravel(unit, stepVec * (1 / len), len, &builtPresent, {}, &hit, from, 0.05, len - kTravelTol) < len - kTravelTol) return false;
              }
            }
          }
        }
        return true;
      };
      std::vector<Vec3> route;
      std::vector<double> routeAt, routeTurn;
      double sLift = 0, sCruise = 0, sJoin = 0, sEntry = 0, sSeat = 0;
      if (!turnsInPath) {
        // How high the crossing must go: at least clear of the unit's own seat, at most clear of
        // everything (the field's whole height, with the unit's turn reach). The exact check
        // decides the lowest level in between that actually clears, rather than climbing to the
        // field's overestimate.
        const double base = std::max(up(S), up(P[0])) + below + style.clearance;
        double across = -std::numeric_limits<double>::infinity();
        for (int k = 0; k <= N; k++) {
          const size_t a = static_cast<size_t>(std::max(0, k - 1)), b = static_cast<size_t>(std::min(N, k + 1));
          const double out = std::max({reach[a], reach[static_cast<size_t>(k)], reach[b]}), dn = std::max({drop[a], drop[static_cast<size_t>(k)], drop[b]});
          across = std::max(across, standing(ax + dir.x * k * dx, az + dir.z * k * dx, out) + style.clearance + dn);
        }
        const double lowLevel = std::max(base, up(J));
        const double highLevel = std::max({base + deepest, across, std::max({built.highest(), temp.highest(), groundUp}) + style.clearance + deepest, up(J)});
        auto attempt = [&](bool useDirect, Vec3 join, bool useArc, double level) {
          direct = useDirect;
          arc = useArc;
          buildRoute(useDirect, join, useArc, level, route, routeTurn, sLift, sCruise, sJoin, sEntry, sSeat);
          routeAt.assign(1, 0);
          for (size_t k = 1; k < route.size(); k++) routeAt.push_back(routeAt.back() + length(route[k] - route[k - 1]));
          if (route.size() < 2) return false;
          Flight trial;  // in the model: the pivot where its seat stands there
          trial.route = route, trial.routeAt = routeAt, trial.routeTurn = routeTurn, trial.turnFrom = r0, trial.pivot = seatPivot;
          return clearAcross(trial, sLift, sCruise, sJoin, sEntry, sSeat);
        };
        // Human-like first: carry it straight to its own way in, turning to its seat's way on the
        // way, and slide it home. That far end lies outside the model, so the straight carry runs
        // clear; try a little further out when even that is blocked. Only a piece that cannot get
        // there at all is lifted over what stands.
        bool placed = false;
        if (style.shape == FlightShape::Auto) {
          for (double e : {0.0, 40.0, 120.0, 320.0}) {
            const Vec3 join = P[np - 1] + dOut * e;
            if (e > 0 && up(join) - below < groundUp) break;
            // Fast 2.5D heightfield pre-filter along the straight line from S to join: if the
            // straight line passes well below the standing obstacles' heightfield, skip the
            // expensive 3D sweep and move on.
            bool lineCouldClear = true;
            for (int k = 1; k < 8; k++) {
              const double u = static_cast<double>(k) / 8;
              const Vec3 pt = S + (join - S) * u;
              if (standing(pt.x, pt.z, 0) > up(pt) + unitRadius) {
                lineCouldClear = false;
                break;
              }
            }
            if (!lineCouldClear) continue;
            if (attempt(true, join, false, lowLevel)) { placed = true; break; }
          }
        }
        std::vector<bool> shapes{false};
        if (style.shape == FlightShape::Arc && X > 4) shapes.insert(shapes.begin(), true);
        for (size_t si = 0; !placed && si < shapes.size(); si++) {
          const bool useArc = shapes[si];
          const double startLo = std::max(lowLevel, across - deepest - style.clearance - 8.0);
          if (attempt(false, J, useArc, startLo)) {
            if (startLo <= lowLevel + 1.0 || attempt(false, J, useArc, lowLevel)) { placed = true; break; }
            double lo = lowLevel, hi = startLo;
            for (int it = 0; it < 5 && hi - lo > 1; it++) {
              const double mid = 0.5 * (lo + hi);
              if (attempt(false, J, useArc, mid)) hi = mid; else lo = mid;
            }
            attempt(false, J, useArc, hi);
            placed = true;
            break;
          }
          if (!attempt(false, J, useArc, highLevel)) continue;                // this shape cannot clear at all
          double lo = startLo, hi = highLevel;
          for (int it = 0; it < 6 && hi - lo > 1; it++) {                     // lowest level the check accepts
            const double mid = 0.5 * (lo + hi);
            if (attempt(false, J, useArc, mid)) hi = mid; else lo = mid;
          }
          attempt(false, J, useArc, hi);
          placed = true;
          break;
        }
        if (!placed && !f.fallback) f.fallback = true, f.fallbackAt = 2;
      }
      if (!turnsInPath && route.size() >= 2) {
        // The clock. Direct: one eased carry to its own way in, then the push in along its corners.
        // The web's: up by 0.24, across by 0.76, and down into the seat by 1, each leg eased from
        // rest to rest. Down is one leg for as long as the way keeps straight down; where it then
        // goes in another way (from the side), across ends at 0.56, down at 0.8, and the push in
        // along the plan's way takes the last 0.2, split at its corners.
        size_t kd = 0;
        if (direct) kd = 1;  // the carry ends at J; the way in begins there
        else {
          while (kd + 1 < route.size() && routeAt[kd] < sCruise - 1e-9) kd++;
          while (kd + 1 < route.size() && dot(normalized(route[kd + 1] - route[kd]), down) > std::cos(3 * M_PI / 180)) kd++;
        }
        const double sDown = std::max(direct ? sJoin : sCruise, routeAt[kd]);
        std::vector<double> stops;  // where the push in turns a corner, and its end
        for (size_t k = kd + 1; k + 1 < route.size(); k++) {
          const Vec3 a = normalized(route[k] - route[k - 1]), b = normalized(route[k + 1] - route[k]);
          if (dot(a, b) < std::cos(3 * M_PI / 180)) stops.push_back(routeAt[k]);
        }
        const bool push = routeAt.back() > sDown + 1e-6;
        if (push) stops.push_back(routeAt.back());
        double from = sDown, t = 0.8;
        if (direct) {
          t = push ? 0.6 : 0.9;
          f.phases = {{0, t, 0, sJoin}};
          from = sJoin;
        } else {
          const double across = push ? 0.56 : 0.76;
          if (arc) f.phases = {{0, across, 0, sCruise}};  // up and over as one sweep, from rest to rest
          else f.phases = {{0, 0.24, 0, sLift}, {0.24, push ? 0.32 : 0.52, sLift, sCruise}};
          f.phases.push_back({across, 0.24, sCruise, push ? sDown : routeAt.back()});
        }
        const double tailFrom = from, tailSpace = 1 - t;
        for (double to : stops) {
          const double share = routeAt.back() > tailFrom + 1e-6 ? tailSpace * (to - from) / (routeAt.back() - tailFrom) : 0;
          f.phases.push_back({t, share, from, to});
          t += share, from = to;
        }
        f.frames = std::max(1, static_cast<int>(std::ceil(flightSeconds * std::max(0.01, style.time) * fps - 1e-9)));
        for (Flight::Phase& ph : f.phases) ph.start *= f.frames, ph.frames *= f.frames;
        // A direct carry turns by distance along it (as routeTurn says); the web's turns on its
        // crossing leg; an arc by distance too.
        f.turnPhase = direct || arc ? -1 : (turning ? 1 : -1);
        f.direct = direct;
        // Into the unit's frame: motions are from its seat there.
        const Xform back = carry.inverse();
        for (Vec3& v : route) v = back.apply(v);
        f.route = route, f.routeAt = routeAt, f.routeTurn = routeTurn, f.pivot = pivot, f.turnFrom = r0;
        f.ease = style.ease;
        // When it has lifted, when it joins the plan's way, and when it is the last stretch from its seat.
        auto frameAt = [&](double sAt) {
          for (const Flight::Phase& ph : f.phases) {
            if (sAt > ph.to + 1e-9) continue;
            double lo = 0, hi = ph.frames;
            for (int it = 0; it < 40; it++) {
              const double mid = (lo + hi) / 2;
              (ph.from + (ph.to - ph.from) * eased(f.ease, ph.frames > 0 ? mid / ph.frames : 1) < sAt ? lo : hi) = mid;
            }
            return ph.start + hi;
          }
          return static_cast<double>(f.frames);
        };
        f.liftAt = direct ? 0.25 * f.phases.front().frames : arc ? frameAt(sLift) : f.phases.front().frames;
        f.pathAt = frameAt(sJoin);
        f.seatAt = std::max(f.pathAt, frameAt(std::max(sJoin, routeAt.back() - (std::max(f.seatTravel, 4.0) + 8))));
        f.seatFrames = f.frames - f.seatAt;
        f.waypoints = {f.staging, Xform{}};
        f.at = {0, 1};
      } else {
        // A plan's way that turns: up, across above everything (turning to the way's first pose
        // on the way, as the web's slerp), down onto the way and along its legs, on the web's
        // clock (up 0.24, across to 0.76, or to 0.56 and down by 0.8 with the legs in the last 0.2).
        const Box ub = boxOf(unit);
        auto raised = [&](Vec3 t) {
          Vec3 r = t;
          r.y = std::min(t.y, all.min.y - kExitMargin - ub.max.y - carry.t.y);
          return r;
        };
        const Vec3 open = m.path.back().t;
        f.staging.r = Mat3{};
        f.waypoints = {f.staging, Xform{}, Xform{}};
        f.waypoints[1].t = raised(f.staging.t), f.waypoints[2].t = raised(open), f.waypoints[2].r = m.path.back().r;
        for (size_t k = m.path.size(); k-- > 0;) f.waypoints.push_back(m.path[k]);
        const size_t n = f.waypoints.size();
        if (n <= 4) {
          f.at = {0, 0.24, 0.76, 1};
        } else {
          f.at = {0, 0.24, 0.56, 0.8};
          double total = 0;
          for (size_t k = 3; k + 1 < n; k++) total += length(f.waypoints[k + 1].t - f.waypoints[k].t);
          for (size_t k = 3; k + 1 < n; k++)
            f.at.push_back(f.at.back() + 0.2 * (total > 1e-9 ? length(f.waypoints[k + 1].t - f.waypoints[k].t) / total : 1.0 / static_cast<double>(n - 4)));
          f.at.back() = 1;
        }
        f.ease = style.ease;
        f.frames = std::max(1, static_cast<int>(std::ceil(flightSeconds * std::max(0.01, style.time) * fps - 1e-9)));
        f.pathAt = f.at[2] * f.frames, f.seatAt = f.at[f.at.size() - 2] * f.frames, f.seatFrames = f.frames - f.seatAt;
        f.liftAt = f.at[1] * f.frames;
      }
    } else {
      f.waypoints = {Xform{}};
      f.at = {1};
    }
    // It lands: its pieces stand where it put them.
    landed[i] = 1;
    for (uint32_t p : unit) {
      worldOf[p] = nd.carry;
      if (nd.f.parent < 0) {
        onSpot[p] = 0;
        builtPresent[p] = 1;
        if (!local[p].empty()) built.add(local[p].transformed(pieces[p].world));
      } else {
        onSpot[p] = 1;
        if (!local[p].empty()) {
          const Xform pose = nd.carry * pieces[p].world;
          temp.add(local[p].transformed(pose));
          tempList.push_back({p, pose, local[p].transformed(pose)});
        }
      }
    }
    if (nd.own >= 0) tempDirty = true;  // a unit has left its spot
  }

  // --- 4. when: one after another, a pause where the build moves to its next step ---
  std::vector<std::vector<int>> keys(count);
  int changes = 0;
  double flying = 0;
  {
    std::vector<int> last;
    bool any = false;
    for (size_t i = 0; i < count; i++) {
      const Node& nd = nodes[i];
      if (nd.own >= 0 || nd.f.frames <= 0) continue;
      keys[i] = stepsOf(pieces[nd.plan->moves[nd.mi].unit.pieces.front()]);
      if (any && keys[i] != last) changes++;
      last = keys[i], any = true;
      flying += nd.f.frames / fps;
    }
  }
  const double pause = webPause >= 0 ? webPause : changes > 0 ? std::min(style.stepPause, 0.2 * flying / changes) : 0;
  double clock = 0;  // frames
  {
    std::vector<int> last;
    bool any = false;
    for (size_t i = 0; i < count; i++) {
      Node& nd = nodes[i];
      Flight& f = nd.f;
      if (f.frames <= 0) {
        f.startFrame = static_cast<int>(std::ceil(clock - 1e-9));
        f.appearFrame = f.startFrame;
        continue;
      }
      if (nd.own < 0) {
        if (any && keys[i] != last) clock += pause * fps;
        last = keys[i], any = true;
      }
      f.startFrame = static_cast<int>(std::ceil(clock - 1e-9));
      clock = f.startFrame + f.frames + style.gap * fps;
    }
  }
  // When each window drops onto the floor: once the window before it has all lifted.
  for (size_t ci = 0; ci < ctxs.size(); ci++) {
    Floor& c = ctxs[ci];
    for (size_t wi = 0; wi < c.windows.size(); wi++) {
      double appear = 0;
      if (wi > 0) {
        for (int ni : c.windows[wi - 1]) appear = std::max(appear, nodes[static_cast<size_t>(ni)].f.startFrame + nodes[static_cast<size_t>(ni)].f.liftAt + 0.01 * fps);
      } else {
        if (c.afterNode >= 0) appear = nodes[static_cast<size_t>(c.afterNode)].f.startFrame + nodes[static_cast<size_t>(c.afterNode)].f.frames;
        if (c.parent >= 0 && !ctxs[static_cast<size_t>(c.parent)].appear.empty()) appear = std::max(appear, ctxs[static_cast<size_t>(c.parent)].appear[0]);
      }
      c.appear[wi] = appear;
      for (int ni : c.windows[wi]) nodes[static_cast<size_t>(ni)].f.appearFrame = static_cast<int>(std::ceil(appear - 1e-9));
    }
  }
  for (size_t i = 0; i < count; i++) {
    Node& nd = nodes[i];
    if (nd.own >= 0) nd.f.appearFrame = ctxs[static_cast<size_t>(nd.own)].appear.empty() ? 0 : static_cast<int>(std::ceil(ctxs[static_cast<size_t>(nd.own)].appear[0] - 1e-9));
    else if (!nd.staged) nd.f.appearFrame = nd.f.startFrame;
    out.flights.push_back(std::move(nd.f));
  }
  out.frames = static_cast<int>(std::ceil(clock - 1e-9));
  for (const Flight& f : out.flights) out.frames = std::max(out.frames, f.startFrame + f.frames);
  // A camera that follows the build: one key a second, looking at what is being placed.
  const double radius = 0.5 * length(all.max - all.min);
  const Vec3 centre = (all.min + all.max) * 0.5;
  const int second = std::max(1, static_cast<int>(std::lround(fps)));
  size_t fi = 0;
  for (int at = 0; at <= out.frames; at += second) {
    while (fi + 1 < out.flights.size() && out.flights[fi].startFrame + out.flights[fi].frames < at) fi++;
    Box seat;
    for (uint32_t p : out.flights[fi].pieces) seat.merge(boxes[p]);
    const Vec3 target = seat.empty() ? centre : centre * 0.7 + (seat.min + seat.max) * 0.15;
    const double progress = out.frames > 0 ? static_cast<double>(at) / out.frames : 0;
    out.camera.push_back({at, target, 2.4 * radius + 100, 0.7854 + 1.5708 * progress, 0.4363});
  }
  return out;
}

Xform motionAt(const Timeline& t, size_t flight, double frame) {
  Xform x = poseAt(t.flights[flight], frame);
  for (int up = t.flights[flight].parent, guard = 0; up >= 0 && static_cast<size_t>(up) < t.flights.size() && guard < 64; up = t.flights[static_cast<size_t>(up)].parent, guard++)
    x = poseAt(t.flights[static_cast<size_t>(up)], frame) * x;
  return x;
}

const std::vector<uint32_t>& piecesOf(const Flight& f, const Plan& plan) {
  static const std::vector<uint32_t> none;
  if (!f.pieces.empty()) return f.pieces;
  return f.move < plan.moves.size() ? plan.moves[f.move].unit.pieces : none;
}

bool shownAt(const Flight& f, double frame) {
  const bool flies = f.frames > 0 && !f.waypoints.empty();
  return frame >= (flies ? f.appearFrame : f.startFrame);
}

std::vector<int> owners(const Timeline& t, const Plan& plan, size_t n) {
  std::vector<int> owner(n, -1);
  for (size_t fi = 0; fi < t.flights.size(); fi++)
    for (uint32_t p : piecesOf(t.flights[fi], plan))
      if (p < n && (owner[p] < 0 || t.flights[static_cast<size_t>(owner[p])].depth < t.flights[fi].depth)) owner[p] = static_cast<int>(fi);
  return owner;
}

namespace {

/// The web's landing clock (src/anim/motionStyle.ts landingWarp), for a styled flight.
double landingWarp(double u, double landing, double hover, double landStart) {
  const double land = landing <= 0 ? 1 - landStart : landing;
  const double h = std::min(hover <= 0 ? 0.0 : hover, 0.9 - land);
  const double cruise = std::max(0.05, 1 - land - std::max(0.0, h));
  const double seat = 1 - cruise - h;
  if (u <= cruise) return cruise > 0 ? landStart * u / cruise : landStart;
  if (u <= cruise + h) return landStart;
  return seat > 0 ? landStart + (1 - landStart) * std::clamp((u - cruise - h) / seat, 0.0, 1.0) : 1.0;
}

Quat slerp(Quat a, Quat b, double u) {
  double d = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < 0) b = {-b.w, -b.x, -b.y, -b.z}, d = -d;
  if (d > 0.9995) return {a.w + (b.w - a.w) * u, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u};
  const double th = std::acos(std::clamp(d, -1.0, 1.0)), s = std::sin(th);
  const double ka = std::sin((1 - u) * th) / s, kb = std::sin(u * th) / s;
  return {ka * a.w + kb * b.w, ka * a.x + kb * b.x, ka * a.y + kb * b.y, ka * a.z + kb * b.z};
}

/// The web's flightPose for a Legacy flight (src/anim/timeline.ts:1661), piece for piece: it lifts
/// to `skyY`, crosses to `to` turned by `entry` (or straight down), and lowers, or pushes in.
Xform legacyFlightPose(const Flight& f, double u) {
  const Flight::Legacy& L = f.legacy;
  Xform out;
  if (L.stationary) {
    out = L.from;
    if (L.hasRel) out = out * L.rel;
    return out;
  }
  u = std::clamp((u - L.hold) / (1 - L.hold), 0.0, 1.0);
  const bool lateral = L.entry.x != 0 || L.entry.y != 0 || L.entry.z != 0;
  if (L.hasStyle) u = landingWarp(u, L.landing, L.hover, lateral ? 0.8 : 0.76);
  if (u <= 0 || u >= 1) {
    out = u <= 0 ? L.from : L.to;
    if (L.hasRel) out = out * L.rel;
    return out;
  }
  const auto e = [&](double x) { return eased(f.ease, x); };
  const Mat3 r0 = rotationOf(L.from.r), r1 = rotationOf(L.to.r);
  const Quat q0 = quatOf(r0), q1 = quatOf(r1);
  const Mat3 shape = inverse(r0) * L.from.r;  // what the placement carries beyond its rotation
  auto compose = [&](Vec3 p, Quat q) {
    Xform x;
    x.r = matOf(q) * shape;
    x.t = p;
    return x;
  };
  Vec3 p0 = L.from.t, p1 = L.to.t;
  if (u < 0.24) {  // straight up off the floor, to the height across
    p0.y += (L.skyY - p0.y) * e(u / 0.24);
    out = compose(p0, q0);
  } else if (lateral) {  // across to the entry, then down onto the way in, then the push in
    if (u < 0.56) {
      const double t = e((u - 0.24) / (0.56 - 0.24));
      p0 = {p0.x + (p1.x + L.entry.x - p0.x) * t, L.skyY, p0.z + (p1.z + L.entry.z - p0.z) * t};
      out = compose(p0, slerp(q0, q1, t));
    } else if (u < 0.8) {
      const double t = e((u - 0.56) / (0.8 - 0.56));
      p1 = {p1.x + L.entry.x, L.skyY + (p1.y + L.entry.y - L.skyY) * t, p1.z + L.entry.z};
      out = compose(p1, q1);
    } else {
      const double t = e((u - 0.8) / (1 - 0.8));
      p1 = {p1.x + L.entry.x * (1 - t), p1.y + L.entry.y * (1 - t), p1.z + L.entry.z * (1 - t)};
      out = compose(p1, q1);
    }
  } else {  // level across, then straight down into the seat
    if (u < 0.76) {
      const double t = e((u - 0.24) / (0.76 - 0.24));
      p0 = {p0.x + (p1.x - p0.x) * t, L.skyY, p0.z + (p1.z - p0.z) * t};
      out = compose(p0, slerp(q0, q1, t));
    } else {
      p1.y = L.skyY + (p1.y - L.skyY) * e((u - 0.76) / (1 - 0.76));
      out = compose(p1, q1);
    }
  }
  if (L.hasRel) out = out * L.rel;
  return out;
}

}  // namespace

Xform poseAt(const Flight& f, int frame) { return poseAt(f, static_cast<double>(frame)); }


Xform poseAt(const Flight& f, double frame) {
  if (f.hasLegacy) {
    const Xform& seed = frame <= f.startFrame ? f.legacy.from : f.legacy.to;
    if (f.frames <= 0 || frame <= f.startFrame || frame >= f.startFrame + f.frames) {
      Xform out = seed;
      if (f.legacy.hasRel) out = out * f.legacy.rel;
      return out;
    }
    return legacyFlightPose(f, (frame - f.startFrame) / f.frames);
  }
  if (!f.route.empty() && f.route.size() >= 2 && !f.phases.empty()) {
    if (f.frames <= 0 || frame >= f.startFrame + f.frames) return {};
    if (frame <= f.startFrame) return f.staging;
    const Clock c = clockAt(f, frame - f.startFrame);
    if (f.turnPhase < 0) return routeMotion(f, c.s);
    const size_t tp = static_cast<size_t>(f.turnPhase);
    return routeMotion(f, c.s, c.phase < tp ? 0.0 : c.phase > tp ? 1.0 : c.e);  // it turns as it crosses, as the web's slerp
  }
  if (f.waypoints.empty()) return {};
  if (f.frames <= 0 || frame >= f.startFrame + f.frames) return f.waypoints.back();
  if (frame <= f.startFrame) return f.waypoints.front();
  const double u = (frame - f.startFrame) / f.frames;
  if (!f.air.empty() && f.hoverAt < f.at.size() && u < f.at[f.hoverAt]) {
    double v = u / f.at[f.hoverAt];
    v = v * v * (3 - 2 * v);  // one ease in, one ease out over the whole of the open air
    const double s = v * f.airAt.back();
    const size_t i = std::min<size_t>(f.air.size() - 2, static_cast<size_t>(std::upper_bound(f.airAt.begin(), f.airAt.end(), s) - f.airAt.begin()) - 1);
    const double span = f.airAt[i + 1] - f.airAt[i], w = span > 0 ? (s - f.airAt[i]) / span : 1;
    Xform x = f.waypoints[std::min<size_t>(f.airLeg[i + 1], f.waypoints.size() - 1)];
    x.t = f.air[i] + (f.air[i + 1] - f.air[i]) * w;
    return x;
  }
  for (size_t k = 0; k + 1 < f.waypoints.size() && k + 1 < f.at.size(); k++) {
    if (u > f.at[k + 1]) continue;
    const double spanU = f.at[k + 1] - f.at[k];
    const double v = eased(f.ease, spanU > 0 ? (u - f.at[k]) / spanU : 1);  // each leg from rest to rest, as the web's
    Xform x = f.waypoints[k + 1];
    x.t = f.waypoints[k].t + (f.waypoints[k + 1].t - f.waypoints[k].t) * v;
    // and turning on the way from one leg's pose to the next (the short way), not at its start
    const Mat3 rel = f.waypoints[k].r * transposed(f.waypoints[k + 1].r);
    if (v < 1 && !isIdentity(rel)) x.r = matOf(towardsNone(quatOf(rel), v)) * f.waypoints[k + 1].r;
    return x;
  }
  return f.waypoints.back();
}

std::vector<Vec3> playedPath(const Flight& f, double spacing) {
  (void)spacing;  // the rounded corners are already flown as points about an LDU apart, as poseAt plays them
  std::vector<Vec3> out;
  auto add = [&](Vec3 t) {
    if (out.empty() || length(t - out.back()) > 1e-9) out.push_back(t);
  };
  if (f.route.size() >= 2) {  // after it has turned: straight on (what turns is checked by the strict check)
    for (size_t k = 0; k < f.route.size(); k++)
      if (isIdentity(f.turnFrom) || (f.routeTurn.size() == f.route.size() ? f.routeTurn[k] >= 1 : f.routeAt[k] >= f.turnEnd)) add(routeMotion(f, f.routeAt[k]).t);
  } else if (!f.air.empty()) {
    for (const Vec3& t : f.air) add(t);
    for (size_t k = f.hoverAt + 1; k < f.waypoints.size(); k++) add(f.waypoints[k].t);
  } else {
    for (const Xform& w : f.waypoints) add(w.t);
  }
  return out;
}

namespace {
nlohmann::json planJson(const Plan& plan, const Certificate* cert, const Model& model) {
  nlohmann::json moves = nlohmann::json::array();
  for (size_t i = 0; i < plan.moves.size(); i++) {
    const Move& m = plan.moves[i];
    nlohmann::json j;
    for (uint32_t p : m.unit.pieces) {
      j["pieces"].push_back(model.pieces()[p].id);
      j["parts"].push_back(model.pieces()[p].part);
    }
    j["source"] = name(m.source);
    j["insertion"] = {m.insertion.x, m.insertion.y, m.insertion.z};
    j["seatTravel"] = m.seatTravel;
    j["path"] = nlohmann::json::array();
    for (const Xform& x : m.path) j["path"].push_back({x.t.x, x.t.y, x.t.z});
    j["flag"] = name(m.flag);
    if (m.blocker != UINT32_MAX) j["blocker"] = model.pieces()[m.blocker].id;
    if (m.sub >= 0) j["sub"] = m.sub;
    if (cert && i < cert->moves.size()) {
      const MoveCheck& c = cert->moves[i];
      j["certified"] = c.certified();
      if (!c.certified() && !c.flagged) j["failed"] = {{"joined", c.joined}, {"clear", c.clear}, {"alongConnector", c.alongConnector}};
    }
    moves.push_back(std::move(j));
  }
  nlohmann::json out;
  out["moves"] = std::move(moves);
  out["subs"] = nlohmann::json::array();
  for (size_t i = 0; i < plan.subs.size(); i++) out["subs"].push_back(planJson(plan.subs[i], cert && i < cert->subs.size() ? &cert->subs[i] : nullptr, model));
  return out;
}
}  // namespace

nlohmann::json toJson(const Plan& plan, const Certificate* cert, const Model& model) {
  nlohmann::json out = planJson(plan, cert, model);
  out["format"] = "brickmotion-native-plan";
  out["version"] = 1;
  out["sweep"] = "continuous 0.001";  // legs are checked along their length, to collide::kCrossingResolution
  out["planMs"] = plan.planMs;
  out["complete"] = plan.complete;
  out["notes"] = plan.notes;
  if (cert) out["certificate"] = {{"moves", cert->total}, {"certified", cert->certified}, {"floating", cert->floating}, {"crossings", cert->crossings}, {"offAxis", cert->offAxis}, {"flagged", cert->flagged}, {"unjoined", cert->unjoined}};
  return out;
}

nlohmann::json toJson(const Timeline& t) {
  nlohmann::json out;
  out["frames"] = t.frames;
  out["flights"] = nlohmann::json::array();
  for (const Flight& f : t.flights) {
    nlohmann::json j{{"move", f.move}, {"startFrame", f.startFrame}, {"frames", f.frames}, {"appearFrame", f.appearFrame}, {"parent", f.parent}, {"at", f.at}, {"direct", f.direct}};
    for (const Xform& x : f.waypoints) j["waypoints"].push_back({x.t.x, x.t.y, x.t.z});
    if (f.route.size() >= 2) {  // the pivot's way, its turn along it, and the legs as timed
      for (size_t k = 0; k < f.route.size(); k++) j["route"].push_back({f.route[k].x, f.route[k].y, f.route[k].z, f.routeTurn.size() == f.route.size() ? f.routeTurn[k] : 1.0});
      j["pivot"] = {f.pivot.x, f.pivot.y, f.pivot.z};
      for (const Flight::Phase& ph : f.phases) j["phases"].push_back({{"start", ph.start}, {"frames", ph.frames}, {"from", ph.from}, {"to", ph.to}});
      j["seatFrames"] = f.seatFrames;
    }
    out["flights"].push_back(std::move(j));
  }
  out["camera"] = nlohmann::json::array();
  for (const CameraKey& k : t.camera) out["camera"].push_back({{"frame", k.frame}, {"target", {k.target.x, k.target.y, k.target.z}}, {"distance", k.distance}, {"azimuth", k.azimuth}, {"elevation", k.elevation}});
  return out;
}

}  // namespace bm::plan
