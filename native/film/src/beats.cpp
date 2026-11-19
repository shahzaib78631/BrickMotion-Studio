#include "bmf/beats.h"
#include <algorithm>
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

}  // namespace bm::film
