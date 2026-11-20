// The web app's Standard ("legacy") planner, ported as it is: src/anim/timeline.ts buildTimeline
// -> planTimeline. Its stages are kept in the source's order so each can be diffed against the TS:
//   A pieces and their metrics               (timeline.ts:488-556)
//   B scene constants and floor bands        (timeline.ts:589-608)
//   E floor windows and waiting poses        (timeline.ts:872-979)
//   D pacing and the schedule                (timeline.ts:767-868)
//   G each flight's way through the air      (timeline.ts:1003-1492)
//   H camera and the result                  (timeline.ts:1493-1577)
// Not ported yet, and the next milestones: submodel units (buildSub / PlayAttach), and the
// connector- and slot-evidence ways (snapMates / attachments). A unit here is one top-level
// piece, and its way in is chosen from UP, the sides and the slide axis. Everything else is the
// web's, piece for piece.
#include "bm/plan/legacy.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <numeric>
#include <string>
#include <unordered_map>
#include <vector>
#include "bm/collide/pair.h"
#include "bm/collide/world.h"
#include "bm/plan/staging.h"

namespace bm::plan::legacy {
namespace {

using staging::kStud;
constexpr double kFlightClearance = 24;  // a brick
constexpr double kAirLane = 80;          // extra height when two airborne trajectories intersect
constexpr double kStudGrip = 8;

bool boxesTouch(const Box& a, const Box& b) {  // timeline.ts:1591, NEAR = 1
  return std::min(a.max.x, b.max.x) - std::max(a.min.x, b.min.x) > -1 && std::min(a.max.y, b.max.y) - std::max(a.min.y, b.min.y) > -1 &&
         std::min(a.max.z, b.max.z) - std::max(a.min.z, b.min.z) > -1;
}

/// How far a box must go along unit `way` to be clear of every box in `boxes` (timeline.ts:1320).
double clearOf(const Box& dst, const std::vector<Box>& boxes, Vec3 way) {
  double far = 0;
  const double lo[3] = {dst.min.x, dst.min.y, dst.min.z}, hi[3] = {dst.max.x, dst.max.y, dst.max.z};
  const double w[3] = {way.x, way.y, way.z};
  for (const Box& b : boxes) {
    double d = std::numeric_limits<double>::infinity();
    const double bl[3] = {b.min.x, b.min.y, b.min.z}, bh[3] = {b.max.x, b.max.y, b.max.z};
    for (int k = 0; k < 3; k++) {
      if (w[k] > 1e-6) d = std::min(d, (bh[k] - lo[k]) / w[k]);
      else if (w[k] < -1e-6) d = std::min(d, (hi[k] - bl[k]) / -w[k]);
    }
    far = std::max(far, d);
  }
  return far;
}

/// The side to slide a piece in from when it sits deep inside what holds it (timeline.ts:1615).
std::pair<int, double> slideAxis(const Box& dst, const std::vector<Box>& built) {
  const Box* best = nullptr;
  double bestVolume = 0;
  for (const Box& box : built) {
    const double ox = std::min(dst.max.x, box.max.x) - std::max(dst.min.x, box.min.x);
    const double oy = std::min(dst.max.y, box.max.y) - std::max(dst.min.y, box.min.y);
    const double oz = std::min(dst.max.z, box.max.z) - std::max(dst.min.z, box.min.z);
    if (ox <= 1 || oy <= 1 || oz <= 1) continue;
    if (!(oy > kStudGrip && oy > 0.5 * std::min(dst.max.y - dst.min.y, box.max.y - box.min.y))) continue;
    const double volume = ox * oy * oz;
    if (!best || volume > bestVolume) best = &box, bestVolume = volume;
  }
  if (!best) return {0, 0};
  const double d[3] = {(dst.min.x + dst.max.x) / 2 - (best->min.x + best->max.x) / 2, (dst.min.y + dst.max.y) / 2 - (best->min.y + best->max.y) / 2,
                       (dst.min.z + dst.max.z) / 2 - (best->min.z + best->max.z) / 2};
  int axis = 0;
  for (int k = 1; k < 3; k++)
    if (std::abs(d[k]) > std::abs(d[axis])) axis = k;
  if (axis == 1) return d[1] < 0 ? std::make_pair(1, -1.0) : std::make_pair(0, 0.0);
  return {axis, d[axis] < 0 ? -1.0 : 1.0};
}

/// A piece, as the web's Instance + Metrics carry it: its seat, its boxes and its mesh.
struct Piece0 {
  uint32_t at = 0;
  std::string key, part;
  int step = 0;
  Xform world;
  Box body, full;  ///< local, part space
  std::shared_ptr<const ldraw::Mesh> mesh;
};

/// The proper rotation of a placement (src/anim/affineTransform.ts), for the floor's own way up.
Mat3 rotationOf(const Mat3& r) {
  const Vec3 a{r.m[0], r.m[3], r.m[6]}, b{r.m[1], r.m[4], r.m[7]}, c{r.m[2], r.m[5], r.m[8]};
  const double la = length(a), det = dot(a, cross(b, c));
  if (la < 1e-8 || !(std::abs(det) > 1e-12)) return Mat3{};
  const Vec3 x = a * (1 / (la * (det < 0 ? -1 : 1)));
  const Vec3 by = b - x * dot(x, b);
  if (length(by) < 1e-8) return Mat3{};
  const Vec3 y = by * (1 / length(by)), z = cross(x, y);
  Mat3 out;
  out.m[0] = x.x, out.m[1] = y.x, out.m[2] = z.x, out.m[3] = x.y, out.m[4] = y.y, out.m[5] = z.y, out.m[6] = x.z, out.m[7] = y.z, out.m[8] = z.z;
  return out;
}
Mat3 transposed(const Mat3& r) {
  Mat3 t;
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) t.m[i * 3 + j] = r.m[j * 3 + i];
  return t;
}

}  // namespace

Timeline buildLegacyTimeline(const Model& model, ldraw::PartCache& parts, connect::ConnectorDb& connectors, connect::Graph& graph,
                             const Plan& authored, const Style& style, Vec3 down) {
  (void)connectors;
  (void)authored;
  (void)down;
  Timeline out;
  const auto& modelPieces = model.pieces();
  const size_t n = modelPieces.size();
  if (!n) return out;
  const double fps = style.fps > 0 ? style.fps : 30;

  // --- A: pieces and their metrics -----------------------------------------
  std::vector<Piece0> inst(n);
  std::vector<Box> boxes(n);
  Box all;
  for (size_t i = 0; i < n; i++) {
    const Piece& p = modelPieces[i];
    inst[i].at = static_cast<uint32_t>(i);
    inst[i].key = p.id;
    inst[i].part = p.part;
    inst[i].step = p.step;
    inst[i].world = p.world;
    inst[i].mesh = model.mesh(p.part, parts);
    inst[i].full = inst[i].mesh && !inst[i].mesh->bounds.empty() ? inst[i].mesh->bounds : kPlaceholderBox;
    inst[i].body = inst[i].mesh && !inst[i].mesh->body.empty() ? inst[i].mesh->body : kPlaceholderBox;
    boxes[i] = inst[i].full.transformed(p.world);
    all.merge(boxes[i]);
  }
  if (all.empty()) return out;
  const double ground = all.max.y;  // the floor: the model's lowest bottom (-y is up)
  const staging::Footprint layout{all.min.x, all.min.z, all.max.x, all.max.z};

  auto padArea = [&](const std::vector<uint32_t>& set) {
    double sum = 0;
    for (uint32_t p : set) {
      const Box& b = inst[p].body;
      if (b.empty()) continue;
      sum += (std::ceil((b.max.x - b.min.x) / kStud - 0.01) + 1) * (std::ceil((b.max.z - b.min.z) / kStud - 0.01) + 1);
    }
    return sum;
  };
  auto initialBands = [&](const staging::Footprint& f, double area) {
    return style.floorStyle == staging::Style::CameraFrame ? staging::cameraFrameBands(f, area, style.floorSides, style.floorAspect)
                                                           : staging::bandsAround(f, area, style.floorSides);
  };
  const double floorArea = staging::styleArea(style.floorStyle);
  std::vector<uint32_t> every(n);
  std::iota(every.begin(), every.end(), 0u);
  const std::vector<staging::Region> bands = initialBands(layout, padArea(every) * floorArea);

  auto stepsOf = [&](uint32_t p) { return modelPieces[p].steps.empty() ? std::vector<int>{modelPieces[p].step} : modelPieces[p].steps; };

  // B: the play order (the web's assembly order): authored step, then the file's order.
  std::vector<uint32_t> play(every);
  std::stable_sort(play.begin(), play.end(), [&](uint32_t a, uint32_t b) { return stepsOf(a) != stepsOf(b) ? stepsOf(a) < stepsOf(b) : a < b; });

  // --- E: the floor, windows of waiting pieces ------------------------------
  auto floorTurn = [&](uint32_t p) { return transposed(rotationOf(inst[p].world.r)); };  // wait as drawn
  auto turnedBox = [&](uint32_t p, const Mat3& turn) { return inst[p].full.transformed(Xform{turn, {}}); };

  std::vector<std::vector<int>> stepList;
  for (uint32_t p : play)
    if (std::find(stepList.begin(), stepList.end(), stepsOf(p)) == stepList.end()) stepList.push_back(stepsOf(p));
  std::vector<int> partRank(n);
  {
    std::vector<std::string> names;
    for (const Piece& p : modelPieces) names.push_back(p.part);
    std::sort(names.begin(), names.end());
    names.erase(std::unique(names.begin(), names.end()), names.end());
    for (size_t i = 0; i < n; i++) partRank[i] = static_cast<int>(std::lower_bound(names.begin(), names.end(), modelPieces[i].part) - names.begin());
  }
  auto stepIndexOf = [&](uint32_t p) { return static_cast<double>(std::find(stepList.begin(), stepList.end(), stepsOf(p)) - stepList.begin()); };

  std::vector<staging::Item> items;
  for (uint32_t p : play) {
    staging::Item it;
    it.id = p;
    it.key = modelPieces[p].id;
    const Box b = turnedBox(p, floorTurn(p));
    it.w = std::max(1, static_cast<int>(std::ceil((b.max.x - b.min.x) / kStud - 0.01)));
    it.d = std::max(1, static_cast<int>(std::ceil((b.max.z - b.min.z) / kStud - 0.01)));
    it.group = style.floorSort == staging::Sort::Colour ? modelPieces[p].color
               : style.floorSort == staging::Sort::Part  ? partRank[p]
               : style.floorSort == staging::Sort::All   ? 0.0
                                                         : stepIndexOf(p);
    items.push_back(it);
  }
  const std::vector<staging::Window> windows = staging::windowed(items, bands, style.floorStyle, nullptr, style.floorAspect);
  const staging::Layout laid = staging::layoutBands(items, bands, style.floorStyle, nullptr, style.floorAspect);

  std::vector<Xform> floorOf(n);
  std::vector<Box> floorBoxOf(n);
  std::vector<std::vector<uint32_t>> windowIds;
  Box scene = all;
  for (const staging::Window& win : windows) {
    const staging::Positions& pos = laid.overflow.empty() ? laid.pos : win.pos;
    std::vector<uint32_t> ids;
    for (uint32_t id : win.ids) {
      const Box b = turnedBox(id, floorTurn(id));
      const auto found = pos.find(id);
      const staging::Spot s = found != pos.end() ? found->second : staging::Spot{bands[0].x0, bands[0].z0};
      Xform floor;
      floor.r = floorTurn(id);
      floor.t = {s.x * kStud - b.min.x, ground - b.max.y, s.z * kStud - b.min.z};
      floorOf[id] = floor;
      floorBoxOf[id] = inst[id].full.transformed(floor);
      scene.merge(floorBoxOf[id]);
      ids.push_back(id);
    }
    windowIds.push_back(ids);
  }

  // --- D: pacing and the schedule ------------------------------------------
  // The web's one by one: each flight 0.85 of a piece's slot, 0.35 s to 0.9 s, a pause at a step.
  const int flyingUnits = static_cast<int>(n);
  double flightSeconds = std::clamp(0.85 / std::max(0.01, style.piecesPerSecond), 0.35, 0.9);
  const int stepCount = static_cast<int>(stepList.size());
  double webPause = -1;
  if (style.targetSeconds > 0) {
    const double intro = std::clamp(style.introSeconds >= 0 ? style.introSeconds : 1.0, 0.2, 120.0);
    const double outro = std::clamp(style.outroSeconds >= 0 ? style.outroSeconds : (style.heroOrbit ? 3.0 : 0.5), 0.2, 120.0);
    const double base = std::max(1.0, style.buildSeconds >= 0 ? style.buildSeconds : style.targetSeconds - intro - outro);
    const double pauseTotal = stepCount > 1 ? std::min(0.25 * (stepCount - 1), 0.2 * base) : 0;
    const double slot = flyingUnits > 0 ? (base - pauseTotal) / flyingUnits : base - pauseTotal;
    flightSeconds = std::clamp(slot * 0.85, 0.35, 0.9);
    webPause = stepCount > 1 ? pauseTotal / (stepCount - 1) : 0;
  }
  const int flightFrames = std::max(1, static_cast<int>(std::ceil(flightSeconds * std::max(0.01, style.time) * fps - 1e-9)));
  const double pause = webPause >= 0 ? webPause : stepCount > 1 ? std::min(style.stepPause, 0.2 * (flightSeconds * flyingUnits) / stepCount) : 0;

  // --- G: each flight's way through the air --------------------------------
  collide::ShapeCache shapes;
  const collide::World world(model, parts, shapes);
  // A piece's mates: a connector seat may legitimately interlock at its destination (a stud in its
  // socket), exactly as the web lets a holder's own seat through (timeline.ts verifiedInsertion).
  std::vector<std::vector<uint32_t>> mates(n);
  for (const connect::Connection& c : graph.connections) {
    if (c.a >= n || c.b >= n) continue;
    mates[c.a].push_back(c.b);
    mates[c.b].push_back(c.a);
  }
  collide::World::Present present(n, 0);  // 1 once a piece is standing in the model
  std::vector<Box> restingBoxes;          // what stands, for the ways in
  std::vector<Flight> flights(n);
  std::vector<uint32_t> near;
  double builtTop = ground - 24;
  for (size_t k = 0; k < n; k++) builtTop = std::min(builtTop, floorBoxOf[k].min.y);
  double clock = 0;  // frames

  for (size_t u = 0; u < play.size(); u++) {
    const uint32_t p = play[u];
    const Xform worldInv = modelPieces[p].world.inverse();  // motions are from the piece's seat
    Flight& f = flights[u];
    f.pieces = {p};
    f.parent = -1, f.depth = 0;
    f.ease = style.ease;
    f.startFrame = static_cast<int>(std::ceil(clock - 1e-9));
    f.frames = flightFrames;
    f.staging = floorOf[p] * worldInv;
    f.appearFrame = f.startFrame;
    f.hasLegacy = true;
    f.legacy.from = f.staging;
    f.legacy.to = Xform{};  // the seat
    f.legacy.hasRel = false;
    f.legacy.stationary = false;
    f.legacy.hasStyle = false;

    const Box dst = inst[p].full.transformed(modelPieces[p].world);
    const Box fromBox = inst[p].full.transformed(floorOf[p]);
    const double spans[3] = {dst.max.x - dst.min.x, dst.max.y - dst.min.y, dst.max.z - dst.min.z};
    (void)spans;

    // The ways in: from above, the sides, and a sideways slide (the web's boxWays, less the
    // connector and slot evidence the next milestone ports).
    std::vector<Vec3> ways{{0, -1, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}};
    const auto slide = slideAxis(dst, restingBoxes);
    if (slide.second != 0) ways.push_back(slide.first == 0 ? Vec3{slide.second, 0, 0} : Vec3{0, 0, slide.second});

    // The height across: a brick over its own top where it waits and where it lands, over what
    // stands below the way across (timeline.ts:1188).
    const double top = std::min({builtTop, fromBox.min.y, dst.min.y});
    const double bottomOffset = std::max(fromBox.max.y - floorOf[p].t.y, dst.max.y - f.legacy.to.t.y);
    const double extent = std::max(fromBox.max.y - fromBox.min.y, dst.max.y - dst.min.y);
    const double skyY = top - kFlightClearance - bottomOffset;

    bool safe = false;
    Vec3 chosenEntry{};
    double chosenSky = 0, chosenHold = 0;
    for (const Vec3& way : ways) {
      if (safe) break;
      std::vector<Box> around;
      for (const Box& b : restingBoxes)
        if (boxesTouch(dst, b)) around.push_back(b);
      const double longLen = std::max(2 * kStud, clearOf(dst, {all}, way) + kFlightClearance);
      // A way straight down carries no offset at all: it comes down onto its seat (timeline.ts
      // entries() yields [0,0,0] for it), which is what makes its flight the plain up-across-down.
      const bool straightDown = std::abs(way.x) < 1e-8 && std::abs(way.z) < 1e-8 && way.y < 0;
      const std::vector<double> lengths =
          straightDown ? std::vector<double>{0.0} : std::vector<double>{std::max(4.0, clearOf(dst, around, way) + 0.6), longLen, 4, 8, 12, 20};
      for (double len : lengths) {
        if (safe) break;
        if (dst.max.y + way.y * len > ground + 0.5) continue;  // it would sink below the floor
        const Vec3 entry{way.x * len, way.y * len, way.z * len};
        const Vec3 entryMotion = worldInv.r * entry;  // the way in, in the piece's own frame
        for (int lane = 0; lane < 5 && !safe; lane++) {
          const double laneHeight = skyY - lane * std::max(kAirLane, extent + kFlightClearance);
          for (double hold : {0.0, 0.12, 0.24, 0.36, 0.48, 0.6}) {
            Flight trial = f;
            trial.legacy.entry = entryMotion;
            trial.legacy.skyY = laneHeight - modelPieces[p].world.t.y;  // motions compose with world
            trial.legacy.hold = hold;
            bool clear = true;
            for (int s = 0; s <= 24 && clear; s++) {
              const double t = s / 24.0;
              const Xform pose = poseAt(trial, f.startFrame + t * f.frames) * modelPieces[p].world;
              const Box b = inst[p].full.transformed(pose);
              near.clear();
              world.near(b, &present, near);
              for (uint32_t q : near) {
                if (q == p) continue;
                if (std::find(mates[p].begin(), mates[p].end(), q) != mates[p].end()) continue;  // its own mate at its seat
                if (collide::overlap(world.shape(p), pose, world.shape(q), world.pose(q))) {
                  clear = false;
                  break;
                }
              }
            }
            if (clear) { chosenEntry = entry, chosenSky = laneHeight, chosenHold = hold, safe = true; break; }
          }
        }
      }
    }
    const bool lateral = chosenEntry.x != 0 || chosenEntry.y != 0 || chosenEntry.z != 0;
    f.legacy.entry = chosenEntry;
    f.legacy.skyY = (safe ? chosenSky : skyY) - modelPieces[p].world.t.y;
    f.legacy.hold = chosenHold;
    f.liftAt = 0.24 * f.frames;
    f.pathAt = (lateral ? 0.56 : 0.76) * f.frames;
    f.seatAt = (lateral ? 0.8 : 0.76) * f.frames;
    f.seatFrames = f.frames - f.seatAt;
    f.fallback = !safe;
    if (!safe) f.fallbackAt = 2;

    // It lands: it stands where it was put, in the way from then on.
    present[p] = 1;
    restingBoxes.push_back(dst);
    builtTop = std::min(builtTop, dst.min.y);

    clock = f.startFrame + f.frames + style.gap * fps;
    if (u + 1 < play.size() && stepsOf(p) != stepsOf(play[u + 1])) clock += pause * fps;
  }

  // Window appear times: once the window before it has all lifted (timeline.ts:967-980).
  auto playIndex = [&](uint32_t id) { return static_cast<size_t>(std::find(play.begin(), play.end(), id) - play.begin()); };
  for (size_t wi = 0; wi < windowIds.size(); wi++) {
    double appear = 0;
    if (wi > 0)
      for (uint32_t id : windowIds[wi - 1]) {
        const Flight& prev = flights[playIndex(id)];
        appear = std::max(appear, prev.startFrame + prev.liftAt + 0.01 * fps);
      }
    for (uint32_t id : windowIds[wi]) flights[playIndex(id)].appearFrame = static_cast<int>(std::ceil(appear - 1e-9));
  }

  out.flights = std::move(flights);
  out.frames = 0;
  for (const Flight& f : out.flights) out.frames = std::max(out.frames, f.startFrame + f.frames);

  // --- H: camera, one key a second, looking at what is being placed ----------
  const double radius = 0.5 * length(all.max - all.min);
  const Vec3 centre = (all.min + all.max) * 0.5;
  const int second = std::max(1, static_cast<int>(std::lround(fps)));
  size_t fi = 0;
  for (int t = 0; t <= out.frames; t += second) {
    while (fi + 1 < out.flights.size() && out.flights[fi].startFrame + out.flights[fi].frames < t) fi++;
    Box seat;
    for (uint32_t p : out.flights[fi].pieces) seat.merge(boxes[p]);
    const Vec3 target = seat.empty() ? centre : centre * 0.7 + (seat.min + seat.max) * 0.15;
    const double progress = out.frames > 0 ? static_cast<double>(t) / out.frames : 0;
    out.camera.push_back({t, target, 2.4 * radius + 100, 0.7854 + 1.5708 * progress, 0.4363});
  }
  (void)scene;
  return out;
}

}  // namespace bm::plan::legacy
