#include "bmf/beats.h"
#include <algorithm>
#include <cmath>
#include <tuple>

namespace bm::film {

namespace {
double volume(const Box& b) { return b.empty() ? 0 : (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z); }
Box seated(const plan::Plan& plan, const collide::World& world, const plan::Flight& f) {
  Box out;
  for (uint32_t piece : plan::piecesOf(f, plan)) out.merge(world.box(piece));
  return out;
}
}  // namespace

std::vector<Vec3> corners(const Box& b) {
  std::vector<Vec3> out;
  if (b.empty()) return out;
  for (int i = 0; i < 8; i++) out.push_back({i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z});
  return out;
}

Box flyingBox(const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, int flight, double frame) {
  const plan::Flight& f = timeline.flights[static_cast<size_t>(flight)];
  const Xform motion = plan::motionAt(timeline, static_cast<size_t>(flight), frame);
  Box out;
  for (uint32_t piece : plan::piecesOf(f, plan)) out.merge(world.box(piece).transformed(motion));
  return out;
}

Beats beatsOf(const plan::Timeline& t, const plan::Plan& plan, const Model& model, const collide::World& world) {
  Beats out;
  out.frames = t.frames;
  for (uint32_t i = 0; i < model.pieces().size(); i++) out.model.merge(world.box(i));
  const int n = static_cast<int>(t.flights.size());
  auto landing = [&](const plan::Flight& f) { return f.startFrame + f.frames; };

  // What is at rest in its seat at each frame: the top-level flights that have landed.
  std::vector<Box> adds(static_cast<size_t>(t.frames) + 1);
  int lastLanding = 0;
  for (const plan::Flight& f : t.flights) {
    if (f.parent >= 0) continue;
    const int at = std::clamp(landing(f), 0, t.frames);
    adds[static_cast<size_t>(at)].merge(seated(plan, world, f));
    lastLanding = std::max(lastLanding, landing(f));
  }
  out.builtBox.resize(adds.size());
  Box built;
  for (size_t i = 0; i < adds.size(); i++) built.merge(adds[i]), out.builtBox[i] = built;

  // Steps, in the order the top-level flights play.
  std::vector<int> firstOfStep(static_cast<size_t>(n), 0);
  {
    std::vector<int> order;
    for (int i = 0; i < n; i++)
      if (t.flights[static_cast<size_t>(i)].parent < 0) order.push_back(i);
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return t.flights[static_cast<size_t>(a)].startFrame < t.flights[static_cast<size_t>(b)].startFrame; });
    std::vector<int> steps;
    Beat* open = nullptr;
    std::vector<Beat> stepBeats;
    for (int i : order) {
      const plan::Flight& f = t.flights[static_cast<size_t>(i)];
      const auto& pieces = plan::piecesOf(f, plan);
      const std::vector<int> s = pieces.empty() ? std::vector<int>{} : plan::stepsOf(model.pieces()[pieces.front()]);
      if (!open || s != steps) {
        stepBeats.push_back({BeatKind::Step, f.startFrame, landing(f), -1, 0, {}, {}, s});
        open = &stepBeats.back();
        steps = s;
        firstOfStep[static_cast<size_t>(i)] = 1;
      }
      open->end = std::max(open->end, landing(f));
      open->seat.merge(seated(plan, world, f));
    }
    for (Beat& b : stepBeats) out.list.push_back(std::move(b));
  }

  const double modelVolume = std::max(volume(out.model), 1e-9);
  const double tall = out.model.empty() ? 0 : out.model.max.y - out.model.min.y;
  const double wide = out.model.empty() ? 0 : std::max(out.model.max.x - out.model.min.x, out.model.max.z - out.model.min.z);
  for (int i = 0; i < n; i++) {
    const plan::Flight& f = t.flights[static_cast<size_t>(i)];
    // A unit built on its spot: the flights inside it, before its own.
    int from = INT32_MAX, to = INT32_MIN;
    Box spot;
    for (int k = 0; k < n; k++) {
      const plan::Flight& c = t.flights[static_cast<size_t>(k)];
      if (c.parent != i) continue;
      from = std::min(from, c.startFrame), to = std::max(to, landing(c));
      spot.merge(flyingBox(t, plan, world, k, landing(c)));
    }
    if (from < to) out.list.push_back({BeatKind::UnitBuild, from, to, i, 0, spot, {}, {}});
    if (f.frames <= 0) continue;
    Beat b{BeatKind::Flight, f.startFrame, landing(f), i, 0, flyingBox(t, plan, world, i, landing(f)), flyingBox(t, plan, world, i, f.startFrame), {}};
    double importance = kImportanceSize * volume(seated(plan, world, f)) / modelVolume;
    if (from < to) importance += kImportanceUnit;
    if (firstOfStep[static_cast<size_t>(i)]) importance += kImportanceFirst;
    if (f.parent < 0) {
      const int at = std::clamp(landing(f), 1, t.frames);
      const Box& before = out.builtBox[static_cast<size_t>(at - 1)];
      const Box& after = out.builtBox[static_cast<size_t>(at)];
      const double grewTall = before.empty() ? 0 : (after.max.y - after.min.y) - (before.max.y - before.min.y);
      const double grewWide = before.empty() ? 0 : std::max((after.max.x - after.min.x) - (before.max.x - before.min.x), (after.max.z - after.min.z) - (before.max.z - before.min.z));
      if (grewTall > kSilhouetteGrow * tall || grewWide > kSilhouetteGrow * wide) importance += kImportanceSilhouette;
      out.list.push_back({BeatKind::Growth, at, at, i, 0, after, {}, {}});
    }
    b.importance = std::clamp(importance, 0.0, 1.0);
    out.list.push_back(b);
  }
  out.list.push_back({BeatKind::Reveal, lastLanding, t.frames, -1, 1, out.model, {}, {}});
  std::stable_sort(out.list.begin(), out.list.end(), [](const Beat& a, const Beat& b) {
    return std::make_tuple(a.start, static_cast<int>(a.kind), a.flight) < std::make_tuple(b.start, static_cast<int>(b.kind), b.flight);
  });
  return out;
}

bool crosses(Vec3 a, Vec3 b, const Box& box) {
  double lo = 0, hi = 1;
  const double pa[3] = {a.x, a.y, a.z}, pd[3] = {b.x - a.x, b.y - a.y, b.z - a.z}, mn[3] = {box.min.x, box.min.y, box.min.z}, mx[3] = {box.max.x, box.max.y, box.max.z};
  for (int k = 0; k < 3; k++) {
    if (std::abs(pd[k]) < 1e-12) {
      if (pa[k] < mn[k] || pa[k] > mx[k]) return false;
      continue;
    }
    double t0 = (mn[k] - pa[k]) / pd[k], t1 = (mx[k] - pa[k]) / pd[k];
    if (t0 > t1) std::swap(t0, t1);
    lo = std::max(lo, t0), hi = std::min(hi, t1);
    if (lo > hi) return false;
  }
  return true;
}

bool blocks(const collide::World& world, uint32_t piece, Vec3 a, Vec3 b) {
  if (!crosses(a, b, world.box(piece))) return false;
  const collide::Shape& shape = world.shape(piece);
  if (shape.nodes.empty()) return false;
  const Xform back = world.pose(piece).inverse();
  const Vec3 o = back.r * a + back.t, d = (back.r * b + back.t) - o;
  auto inNode = [&](const collide::Node& n) {
    Box box;
    box.min = {n.min[0], n.min[1], n.min[2]}, box.max = {n.max[0], n.max[1], n.max[2]};
    return crosses(o, o + d, box);
  };
  auto at = [&](uint32_t i) {
    const collide::Vec3f& v = shape.outer[shape.triangles[i]];
    return Vec3{v.x, v.y, v.z};
  };
  std::vector<uint32_t> stack{0};
  while (!stack.empty()) {
    const collide::Node& n = shape.nodes[stack.back()];
    stack.pop_back();
    if (!inNode(n)) continue;
    if (n.count == 0) {
      stack.push_back(n.left), stack.push_back(n.left + 1);
      continue;
    }
    for (uint32_t k = n.left; k < n.left + n.count; k++) {  // Moller-Trumbore, t in [0, 1]
      const Vec3 p0 = at(3 * k), e1 = at(3 * k + 1) - p0, e2 = at(3 * k + 2) - p0, h = cross(d, e2);
      const double det = dot(e1, h);
      if (std::abs(det) < 1e-12) continue;
      const double inv = 1 / det;
      const Vec3 sv = o - p0;
      const double u = dot(sv, h) * inv;
      if (u < 0 || u > 1) continue;
      const Vec3 q = cross(sv, e1);
      const double v = dot(d, q) * inv;
      if (v < 0 || u + v > 1) continue;
      const double t = dot(e2, q) * inv;
      if (t >= 0 && t <= 1) return true;
    }
  }
  return false;
}

std::vector<Vec3> seatPoints(const Box& seat) {
  const Vec3 c = (seat.min + seat.max) * 0.5, h = (seat.max - seat.min) * 0.5;
  std::vector<Vec3> out{c};
  for (Vec3 k : corners(seat)) out.push_back(k);
  for (Vec3 d : {Vec3{h.x, 0, 0}, Vec3{0, h.y, 0}, Vec3{0, 0, h.z}}) out.push_back(c + d), out.push_back(c - d);
  return out;
}

}  // namespace bm::film
