#include "bm/kin/mobility.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <numeric>
#include "bm/kin/constraints.h"
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

using connect::JointKind;

Twist turningAbout(Vec3 point, Vec3 axis) { return {axis, cross(point, axis)}; }  // v(origin) = w x (0 - p)
Twist slidingAlong(Vec3 axis) { return {{}, axis}; }

/// The freedoms a single link allows, as twists of the body beyond it.
std::vector<Twist> twistsOf(const Link& l) {
  switch (l.kind) {
    case JointKind::Revolute: return {turningAbout(l.point, l.axis)};
    case JointKind::Prismatic: return {slidingAlong(l.axis)};
    case JointKind::Cylindrical: return {turningAbout(l.point, l.axis), slidingAlong(l.axis)};
    case JointKind::Spherical: return {turningAbout(l.point, {1, 0, 0}), turningAbout(l.point, {0, 1, 0}), turningAbout(l.point, {0, 0, 1})};
    default: return {};
  }
}

bool moving(const Twist& t) { return length(t.angular) > kStill || length(t.linear) > kStill * kLengthUnit; }

void normalise(Freedom& f) {
  double turn = 0, move = 0;
  for (const Twist& t : f.twists) turn = std::max(turn, length(t.angular)), move = std::max(move, length(t.linear));
  const double scale = turn > kStill ? 1 / turn : move > 0 ? 1 / move : 1;
  for (Twist& t : f.twists) t.angular = t.angular * scale, t.linear = t.linear * scale;
}

}  // namespace

Twist twistOf(const Freedom& f, uint32_t body) {
  const auto it = std::lower_bound(f.bodies.begin(), f.bodies.end(), body);
  if (it == f.bodies.end() || *it != body) return {};
  return f.twists[static_cast<size_t>(it - f.bodies.begin())];
}

Mobility mobility(const System& sys) {
  Mobility out;
  const uint32_t n = sys.bodies;
  out.moves.assign(n, 0);
  out.held.assign(n, 0);
  if (n == 0) return out;

  // Groups of bodies joined by links or gearings; the largest body of each stands still.
  std::vector<uint32_t> group(n);
  std::iota(group.begin(), group.end(), 0u);
  auto find = [&](uint32_t i) {
    while (group[i] != i) i = group[i] = group[group[i]];
    return i;
  };
  for (const Link& l : sys.links) group[find(l.a)] = find(l.b);
  for (const Gearing& g : sys.gearings) group[find(g.a)] = find(g.b);
  {
    std::map<uint32_t, uint32_t> best;
    for (uint32_t b = 0; b < n; b++) {
      const auto [it, fresh] = best.emplace(find(b), b);
      if (!fresh && sys.size[b] > sys.size[it->second]) it->second = b;
    }
    if (sys.ground < n) best[find(sys.ground)] = sys.ground;
    for (const auto& [g, b] : best) out.held[b] = 1;
  }

  // Take off the bodies that hang on one link and mesh with nothing: each is free about that
  // link whatever the rest does, and carries along whatever hangs on it in turn.
  std::vector<std::vector<uint32_t>> linksOf(n);
  std::vector<uint8_t> geared(n, 0);
  for (uint32_t i = 0; i < sys.links.size(); i++) linksOf[sys.links[i].a].push_back(i), linksOf[sys.links[i].b].push_back(i);
  for (const Gearing& g : sys.gearings) geared[g.a] = geared[g.b] = 1;
  std::vector<uint32_t> degree(n), hangsOn(n, UINT32_MAX), hangLink(n, UINT32_MAX);
  std::vector<uint8_t> linkGone(sys.links.size(), 0);
  std::vector<uint32_t> queue;
  for (uint32_t b = 0; b < n; b++) {
    degree[b] = static_cast<uint32_t>(linksOf[b].size());
    if (degree[b] == 1 && !geared[b] && !out.held[b]) queue.push_back(b);
  }
  std::vector<uint32_t> taken;  // in the order taken off: leaves before what they hung on
  for (size_t q = 0; q < queue.size(); q++) {
    const uint32_t b = queue[q];
    if (degree[b] != 1 || hangsOn[b] != UINT32_MAX) continue;
    for (uint32_t li : linksOf[b]) {
      if (linkGone[li]) continue;
      const uint32_t other = sys.links[li].a == b ? sys.links[li].b : sys.links[li].a;
      linkGone[li] = 1;
      hangsOn[b] = other;
      hangLink[b] = li;
      degree[b] = 0;
      taken.push_back(b);
      if (--degree[other] == 1 && !geared[other] && !out.held[other]) queue.push_back(other);
      break;
    }
  }
  // Everything that hangs, directly or not, on each body.
  std::vector<std::vector<uint32_t>> carried(n);
  for (uint32_t b : taken) {  // leaves first, so a body's own load is complete before it is passed on
    carried[hangsOn[b]].push_back(b);
    carried[hangsOn[b]].insert(carried[hangsOn[b]].end(), carried[b].begin(), carried[b].end());
  }
  auto finish = [&](Freedom& f, std::map<uint32_t, Twist>& twists) {
    // Whatever hangs on a moving body moves with it.
    std::map<uint32_t, Twist> all = twists;
    for (const auto& [body, twist] : twists)
      for (uint32_t c : carried[body]) all.emplace(c, twist);
    f.bodies.clear();
    f.twists.clear();
    for (const auto& [body, twist] : all) {
      if (!moving(twist)) continue;
      f.bodies.push_back(body);
      f.twists.push_back(twist);
      out.moves[body] = 1;
    }
    normalise(f);
  };
  std::vector<Freedom> locals, others;
  for (uint32_t b : taken) {
    for (const Twist& t : twistsOf(sys.links[hangLink[b]])) {
      Freedom f;
      std::map<uint32_t, Twist> twists{{b, t}};
      finish(f, twists);
      f.local = true;
      f.link = hangLink[b];
      locals.push_back(std::move(f));
    }
  }

  // What is left is solved in pieces that do not affect each other: a body that stands still
  // passes nothing on, so the gearbox, the engine and the steering of one frame are separate.
  std::vector<uint32_t> part(n);
  std::iota(part.begin(), part.end(), 0u);
  auto partOf = [&](uint32_t i) {
    while (part[i] != i) i = part[i] = part[part[i]];
    return i;
  };
  auto inCore = [&](uint32_t b) { return hangsOn[b] == UINT32_MAX && !out.held[b]; };
  for (uint32_t i = 0; i < sys.links.size(); i++)
    if (!linkGone[i] && inCore(sys.links[i].a) && inCore(sys.links[i].b)) part[partOf(sys.links[i].a)] = partOf(sys.links[i].b);
  for (const Gearing& g : sys.gearings)
    if (inCore(g.a) && inCore(g.b)) part[partOf(g.a)] = partOf(g.b);
  std::map<uint32_t, std::vector<uint32_t>> cores;
  for (uint32_t b = 0; b < n; b++)
    if (inCore(b) && (degree[b] > 0 || geared[b])) cores[partOf(b)].push_back(b);
  for (const auto& [g, bodies] : cores) {
    std::vector<int> column(n, -1);
    size_t columns = 0;
    for (uint32_t b : bodies) column[b] = static_cast<int>(columns), columns += 6;
    if (columns == 0) continue;
    if (columns / 6 > static_cast<size_t>(kMaxSolveBodies)) {
      out.solved = false;
      out.reason = std::to_string(columns / 6) + " bodies move together; the limit is " + std::to_string(kMaxSolveBodies);
      continue;
    }
    std::vector<uint32_t> links, gearings;
    auto here = [&](uint32_t b) { return inCore(b) && partOf(b) == g; };
    for (uint32_t i = 0; i < sys.links.size(); i++)
      if (!linkGone[i] && (here(sys.links[i].a) || here(sys.links[i].b))) links.push_back(i);
    for (uint32_t i = 0; i < sys.gearings.size(); i++)
      if (here(sys.gearings[i].a) || here(sys.gearings[i].b)) gearings.push_back(i);
    out.solvedBodies += columns / 6;
    const Equations eq = equations(sys, column, columns, links, gearings);
    const Matrix null = nullSpace(eq.jacobian, kRankTol);
    if (null.cols == 0) continue;
    // Separate the freedoms: each gets a coordinate no other has.
    Matrix rows(null.cols, null.rows);
    for (size_t r = 0; r < null.rows; r++)
      for (size_t c = 0; c < null.cols; c++) rows.at(c, r) = null.at(r, c);
    reduceRows(rows, 1e-9);
    for (size_t r = 0; r < rows.rows; r++) {
      std::map<uint32_t, Twist> twists;
      for (uint32_t b : bodies) {
        if (column[b] < 0) continue;
        const size_t c = static_cast<size_t>(column[b]);
        twists[b] = {{rows.at(r, c), rows.at(r, c + 1), rows.at(r, c + 2)}, Vec3{rows.at(r, c + 3), rows.at(r, c + 4), rows.at(r, c + 5)} * kLengthUnit};
      }
      Freedom f;
      finish(f, twists);
      if (!f.bodies.empty()) others.push_back(std::move(f));
    }
  }
  std::stable_sort(others.begin(), others.end(), [](const Freedom& x, const Freedom& y) { return x.bodies.size() > y.bodies.size(); });
  out.freedoms = std::move(locals);
  out.freedoms.insert(out.freedoms.end(), std::make_move_iterator(others.begin()), std::make_move_iterator(others.end()));
  return out;
}

std::optional<Ratio> ratio(const Freedom& f, uint32_t bodyA, uint32_t bodyB) {
  const Vec3 wa = twistOf(f, bodyA).angular, wb = twistOf(f, bodyB).angular;
  const double a = length(wa), b = length(wb);
  if (a <= kStill) return std::nullopt;
  Ratio out;
  const double cosine = b > kStill ? dot(wa, wb) / (a * b) : 1;
  const double sign = std::abs(cosine) >= kMeshAxis && cosine < 0 ? -1 : 1;
  out.value = sign * b / a;
  // The nearest fraction with a small denominator, by continued fractions.
  double x = std::abs(out.value);
  long h0 = 0, h1 = 1, k0 = 1, k1 = 0;
  for (int i = 0; i < 32; i++) {
    const double whole = std::floor(x);
    if (whole > 1e6) break;
    const long h2 = static_cast<long>(whole) * h1 + h0, k2 = static_cast<long>(whole) * k1 + k0;
    if (k2 > 1000) break;
    h0 = h1, h1 = h2, k0 = k1, k1 = k2;
    if (std::abs(static_cast<double>(h1) / static_cast<double>(k1) - std::abs(out.value)) < 1e-9) break;
    const double rest = x - whole;
    if (rest < 1e-12) break;
    x = 1 / rest;
  }
  if (k1 > 0 && std::abs(static_cast<double>(h1) / static_cast<double>(k1) - std::abs(out.value)) < 1e-9) {
    out.num = static_cast<int>(sign * static_cast<double>(h1));
    out.den = static_cast<int>(k1);
    out.exact = true;
  }
  return out;
}

}  // namespace bm::kin
