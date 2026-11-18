#include "bm/collide/world.h"

#include <mutex>
#include <unordered_map>

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>
#include <unordered_map>

namespace bm::collide {
namespace {

/// What a remembered answer is kept under. Each word goes into two lanes through a mix in which
/// every bit of it reaches every bit of the lane, so that two different questions never share an
/// answer. Multiplying and xoring whole words (FNV) will not do: a multiply keeps a negated word
/// negated, and two odd words both negated xor to what they did before, so a direction and its
/// opposite were kept under one key about half the time.
struct Key {
  uint64_t a = 0x243f6a8885a308d3ull, b = 0x13198a2e03707344ull;
  static uint64_t scramble(uint64_t k) {  // MurmurHash3's finaliser
    k ^= k >> 33;
    k *= 0xff51afd7ed558ccdull;
    k ^= k >> 33;
    k *= 0xc4ceb9fe1a85ec53ull;
    k ^= k >> 33;
    return k;
  }
  Key& add(uint64_t v) {
    a = scramble(a ^ v);
    b = scramble(b + v + 0x9e3779b97f4a7c15ull);
    return *this;
  }
  Key& add(double v, double grain) { return add(static_cast<uint64_t>(static_cast<int64_t>(std::llround(v / grain)))); }
  Key& add(Vec3 v, double grain) { return add(v.x, grain).add(v.y, grain).add(v.z, grain); }
  bool operator==(const Key& o) const { return a == o.a && b == o.b; }
};
struct KeyHash {
  size_t operator()(const Key& k) const { return static_cast<size_t>(k.a); }
};

bool boxesMeet(const Box& a, const Box& b) {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z;
}

/// One shape per distinct part of the model (a model's own inline parts are built here).
std::vector<std::shared_ptr<const Shape>> shapesOf(const Model& model, ldraw::PartCache& parts, ShapeCache& shapes) {
  std::vector<std::shared_ptr<const Shape>> out;
  out.reserve(model.pieces().size());
  std::unordered_map<std::string, std::shared_ptr<const Shape>> byPart;
  for (const Piece& p : model.pieces()) {
    auto it = byPart.find(p.part);
    if (it == byPart.end()) it = byPart.emplace(p.part, shapes.get(model.mesh(p.part, parts))).first;
    out.push_back(it->second);
  }
  return out;
}

bool samePose(const Piece& a, const Piece& b) {
  if (a.part != b.part || length(a.world.t - b.world.t) > 1e-3) return false;
  for (int i = 0; i < 9; i++)
    if (std::abs(a.world.r.m[i] - b.world.r.m[i]) > 1e-4) return false;
  return true;
}

/// The rotation part of `m` as an axis and an angle. False if `m` is not a rotation.
bool axisAngle(const Mat3& m, Vec3& axis, double& angle) {
  const double tr = m.m[0] + m.m[4] + m.m[8];
  if (std::abs(determinant(m) - 1) > 1e-3) return false;
  angle = std::acos(std::min(1.0, std::max(-1.0, (tr - 1) / 2)));
  if (angle < 1e-9) {
    axis = {0, 1, 0};
    angle = 0;
    return true;
  }
  if (3.14159265358979 - angle < 1e-6) {
    // Half a turn: the axis is the largest column of (m + I).
    const Vec3 cols[3] = {{m.m[0] + 1, m.m[3], m.m[6]}, {m.m[1], m.m[4] + 1, m.m[7]}, {m.m[2], m.m[5], m.m[8] + 1}};
    axis = cols[0];
    for (const Vec3& c : cols)
      if (length(c) > length(axis)) axis = c;
    axis = normalized(axis);
    return true;
  }
  axis = normalized(Vec3{m.m[7] - m.m[5], m.m[2] - m.m[6], m.m[3] - m.m[1]});
  return true;
}

Mat3 rotation(Vec3 k, double angle) {
  const double c = std::cos(angle), s = std::sin(angle), v = 1 - c;
  return Mat3{{c + k.x * k.x * v, k.x * k.y * v - k.z * s, k.x * k.z * v + k.y * s, k.y * k.x * v + k.z * s, c + k.y * k.y * v, k.y * k.z * v - k.x * s, k.z * k.x * v - k.y * s, k.z * k.y * v + k.x * s,
               c + k.z * k.z * v}};
}

}  // namespace

Report findOverlaps(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, ShapeCache& shapeCache) {
  Report report;
  const std::vector<Piece>& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  if (graph.isSegment.size() != n) return report;  // a graph of another model
  const auto shapes = shapesOf(model, parts, shapeCache);

  // Sort and sweep on x over the pieces that can collide.
  std::vector<Box> boxes(n);
  std::vector<uint32_t> order;
  for (uint32_t i = 0; i < n; i++) {
    if (graph.isSegment[i] || shapes[i]->nodes.empty()) continue;
    boxes[i] = shapes[i]->bounds.transformed(pieces[i].world);
    if (!boxes[i].empty() && std::isfinite(boxes[i].min.x) && std::isfinite(boxes[i].max.x)) order.push_back(i);
  }
  std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return boxes[a].min.x < boxes[b].min.x; });

  // The pair's mate zones; returns whether the two are joined at all.
  auto zonesFor = [&](uint32_t a, uint32_t b, std::vector<Zone>& out) {
    out.clear();
    bool joined = false;
    const auto at = std::lower_bound(graph.connections.begin(), graph.connections.end(), std::make_pair(a, b), [](const connect::Connection& c, const std::pair<uint32_t, uint32_t>& key) { return c.a != key.first ? c.a < key.first : c.b < key.second; });
    for (auto it = at; it != graph.connections.end() && it->a == a && it->b == b; ++it) {
      joined = joined || it->joint.kind != connect::JointKind::Flexible;
      for (uint32_t z = it->firstZone; z < it->firstZone + it->zoneCount; z++) out.push_back({graph.zones[z].a, graph.zones[z].b, graph.zones[z].radius});
    }
    // Meshed gears are not joined, but their teeth interleave.
    const auto mesh = std::lower_bound(graph.meshes.begin(), graph.meshes.end(), std::make_pair(a, b), [](const kin::GearMesh& m, const std::pair<uint32_t, uint32_t>& key) { return std::make_pair(std::min(m.a, m.b), std::max(m.a, m.b)) < key; });
    if (mesh != graph.meshes.end() && std::min(mesh->a, mesh->b) == a && std::max(mesh->a, mesh->b) == b) {
      const connect::MateZone& z = graph.meshZones[static_cast<size_t>(mesh - graph.meshes.begin())];
      out.push_back({z.a, z.b, z.radius});
    }
    return joined;
  };

  std::vector<Zone> zones;
  for (size_t i = 0; i < order.size(); i++) {
    const uint32_t a = order[i];
    for (size_t j = i + 1; j < order.size() && boxes[order[j]].min.x <= boxes[a].max.x; j++) {
      const uint32_t b = order[j];
      if (!boxesMeet(boxes[a], boxes[b])) continue;
      const uint32_t lo = std::min(a, b), hi = std::max(a, b);
      report.tested++;
      if (samePose(pieces[lo], pieces[hi])) {
        report.overlaps.push_back({lo, hi, pieces[lo].world.t, true, {}});
        continue;
      }
      const bool joined = zonesFor(lo, hi, zones);
      Hit hit;
      if (overlap(*shapes[lo], pieces[lo].world, *shapes[hi], pieces[hi].world, zones, &hit, joined ? Depth::Joined : Depth::Skin)) report.overlaps.push_back({lo, hi, hit.point, false, hit});
    }
  }
  std::sort(report.overlaps.begin(), report.overlaps.end(), [](const Overlap& x, const Overlap& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
  return report;
}

struct World::State {
  std::vector<std::shared_ptr<const Shape>> shapes;
  std::vector<Xform> poses;
  std::vector<Box> boxes;
  std::vector<Box> innerBoxes;   // of each piece's inner surface, in the model
  std::vector<const std::vector<Vec3>*> probes;  // points of each piece's inner surface, in its own space
  std::unordered_map<const Shape*, std::vector<Vec3>> probesOf;
  std::vector<uint32_t> byMinX;  // pieces with geometry, sorted by their box's min x
  double widest = 0;             // the largest box extent along x, to bound the scan
  mutable std::mutex memoLock;
  mutable std::unordered_map<Key, double, KeyHash> memo;  // pairTravel and restCrossing answers
  mutable std::unordered_map<Key, std::optional<std::vector<Zone>>, KeyHash> spots;  // restSpots answers
};

World::World(const Model& model, ldraw::PartCache& parts, ShapeCache& shapeCache) : state_(std::make_unique<State>()) {
  state_->shapes = shapesOf(model, parts, shapeCache);
  const uint32_t n = static_cast<uint32_t>(model.pieces().size());
  state_->boxes.resize(n);
  state_->innerBoxes.resize(n);
  std::unordered_map<const Shape*, Box> innerLocal;
  state_->probes.assign(n, nullptr);
  for (uint32_t i = 0; i < n; i++) {
    state_->poses.push_back(model.pieces()[i].world);
    if (state_->shapes[i]->nodes.empty()) continue;
    {
      // Probes: the points of the inner surface furthest out each way (along the axes and the
      // diagonals). Each is inside the piece by a skin, so wherever one of them passes through
      // another piece's surface the two are certainly in each other.
      auto found = state_->probesOf.find(state_->shapes[i].get());
      if (found == state_->probesOf.end()) {
        const Shape& shape = *state_->shapes[i];
        // Gather the same 6 axial and 8 diagonal extrema in one triangle pass.
        // For large custom parts this avoids scanning the entire inner mesh 14 times.
        std::array<std::array<int, 3>, 14> dirs{};
        size_t dirCount = 0;
        for (int dx = -1; dx <= 1; dx++)
          for (int dy = -1; dy <= 1; dy++)
            for (int dz = -1; dz <= 1; dz++) {
              if (!dx && !dy && !dz) continue;
              if (std::abs(dx) + std::abs(dy) + std::abs(dz) == 2) continue;
              dirs[dirCount++] = {dx, dy, dz};
            }
        std::array<double, 14> best;
        best.fill(-1e300);
        std::array<Vec3, 14> extrema{};
        std::array<uint8_t, 14> valid{};
        for (size_t t = 0; t + 2 < shape.inner.size(); t += 3) {
          const Vec3f &a = shape.inner[t], &b = shape.inner[t + 1];
          if (a.x == b.x && a.y == b.y && a.z == b.z) continue;
          for (size_t c = 0; c < 3; c++) {
            const Vec3f& v = shape.inner[t + c];
            for (size_t d = 0; d < dirCount; d++) {
              const auto& dir = dirs[d];
              const double reach = dir[0] * v.x + dir[1] * v.y + dir[2] * v.z;
              if (reach > best[d]) {
                best[d] = reach;
                extrema[d] = {v.x, v.y, v.z};
                valid[d] = 1;
              }
            }
          }
        }
        std::vector<Vec3> points;
        for (size_t d = 0; d < dirCount; d++) {
          if (!valid[d]) continue;
          const Vec3 at = extrema[d];
          if (std::find_if(points.begin(), points.end(), [&](const Vec3& have) { return length(have - at) < 1e-6; }) == points.end()) points.push_back(at);
        }
        found = state_->probesOf.emplace(state_->shapes[i].get(), std::move(points)).first;
      }
      state_->probes[i] = &found->second;
    }
    state_->boxes[i] = state_->shapes[i]->bounds.transformed(state_->poses[i]);
    {
      // The inner surface's own box: two pieces can only cross where the inner surface of one
      // reaches the true surface of the other.
      auto found = innerLocal.find(state_->shapes[i].get());
      if (found == innerLocal.end()) {
        Box b;
        for (const Vec3f& p : state_->shapes[i]->inner) b.grow({p.x, p.y, p.z});
        found = innerLocal.emplace(state_->shapes[i].get(), b).first;
      }
      state_->innerBoxes[i] = found->second.transformed(state_->poses[i]);
    }
    if (state_->boxes[i].empty() || !std::isfinite(state_->boxes[i].min.x) || !std::isfinite(state_->boxes[i].max.x)) continue;
    state_->byMinX.push_back(i);
    state_->widest = std::max(state_->widest, state_->boxes[i].max.x - state_->boxes[i].min.x);
  }
  std::sort(state_->byMinX.begin(), state_->byMinX.end(), [&](uint32_t a, uint32_t b) { return state_->boxes[a].min.x < state_->boxes[b].min.x; });
}

World::~World() = default;
size_t World::size() const { return state_->poses.size(); }

const Shape& World::shape(uint32_t piece) const { return *state_->shapes[piece]; }
const Box& World::box(uint32_t piece) const { return state_->boxes[piece]; }
const Xform& World::pose(uint32_t piece) const { return state_->poses[piece]; }

void World::near(const Box& box, const Present* present, std::vector<uint32_t>& out) const {
  out.clear();
  if (box.empty() || !std::isfinite(box.min.x) || !std::isfinite(box.max.x)) return;
  const State& s = *state_;
  auto first = std::lower_bound(s.byMinX.begin(), s.byMinX.end(), box.min.x - s.widest, [&](uint32_t i, double x) { return s.boxes[i].min.x < x; });
  for (auto it = first; it != s.byMinX.end() && s.boxes[*it].min.x <= box.max.x; ++it) {
    const uint32_t i = *it;
    if (present && (i >= present->size() || !(*present)[i])) continue;
    if (boxesMeet(box, s.boxes[i])) out.push_back(i);
  }
  std::sort(out.begin(), out.end());
}

namespace {
Xform inverseOf(const Xform& x) {
  Xform out;
  out.r = bm::inverse(x.r);
  out.t = -(out.r * x.t);
  return out;
}
/// The zones that can matter to moving piece `p` against obstacle `q`: those that let the two
/// cross, and near enough to matter (a crossing lies on the obstacle's surface, so inside its box).
std::vector<Zone> zonesNear(const std::vector<Zone>& zones, uint32_t p, uint32_t q, const Box& box) {
  std::vector<Zone> out;
  for (const Zone& z : zones) {
    if (!lets(z, p, q)) continue;
    Box zb;
    zb.grow(z.a), zb.grow(z.b);
    zb.min = zb.min - Vec3{z.radius, z.radius, z.radius}, zb.max = zb.max + Vec3{z.radius, z.radius, z.radius};
    if (boxesMeet(zb, box)) out.push_back(z);
  }
  return out;
}
}  // namespace

/// How far one piece gets along a line before it meets one other, looked at only where their
/// boxes can meet. The answer depends only on the two shapes, how they sit to each other, the line
/// and the zones, all seen from the obstacle; a model repeats the same pairs many times (a pin
/// in a hole, a brick on a brick), so answers are remembered.
double World::pairTravel(uint32_t p, const Xform& from, const Box& fromBox, uint32_t q, Vec3 direction, double distance, const std::vector<Zone>& allZones, double tolerance) const {
  const State& s = *state_;
  const std::vector<Zone> zones = zonesNear(allZones, p, q, s.boxes[q]);
  // When the two can cross at all: while the inner surface of one is within the box of the other.
  const Vec3 offset = from.t - s.poses[p].t;  // this leg starts with the piece moved by this much
  auto window = [&](Box moving, const Box& still, double& enter, double& leave) {
    moving.min = moving.min + offset, moving.max = moving.max + offset;
    enter = 0, leave = distance;
    if (moving.empty() || still.empty()) return false;
    const double lo[3] = {moving.min.x, moving.min.y, moving.min.z}, hi[3] = {moving.max.x, moving.max.y, moving.max.z};
    const double olo[3] = {still.min.x, still.min.y, still.min.z}, ohi[3] = {still.max.x, still.max.y, still.max.z};
    const double d[3] = {direction.x, direction.y, direction.z};
    for (int i = 0; i < 3; i++) {
      if (std::abs(d[i]) < 1e-12) {
        if (hi[i] < olo[i] || lo[i] > ohi[i]) return false;
        continue;
      }
      double t0 = (olo[i] - hi[i]) / d[i], t1 = (ohi[i] - lo[i]) / d[i];
      if (t0 > t1) std::swap(t0, t1);
      enter = std::max(enter, t0), leave = std::min(leave, t1);
    }
    return enter <= leave;
  };
  double enter = distance, leave = 0, e, l;
  bool any = false;
  bool turned = false;
  for (int i = 0; i < 9; i++) turned = turned || std::abs(from.r.m[i] - s.poses[p].r.m[i]) > 1e-9;
  if (turned) {
    // The leg starts with the piece turned: its boxes in the model no longer describe it. Its
    // true box at the start of the leg does, less sharply.
    Box atStart = fromBox;
    atStart.min = atStart.min - offset, atStart.max = atStart.max - offset;
    any = window(atStart, s.boxes[q], enter, leave);
  } else {
    if (window(s.innerBoxes[p], s.boxes[q], e, l)) enter = std::min(enter, e), leave = std::max(leave, l), any = true;
    if (window(s.boxes[p], s.innerBoxes[q], e, l)) enter = std::min(enter, e), leave = std::max(leave, l), any = true;
  }
  if (!any) return distance;

  const Xform toObstacle = inverseOf(s.poses[q]);
  const Xform rel = toObstacle * from;
  Key key;
  key.add(1).add(reinterpret_cast<uintptr_t>(s.shapes[p].get())).add(reinterpret_cast<uintptr_t>(s.shapes[q].get()));
  for (double v : rel.r.m) key.add(v, 1e-4);
  key.add(rel.t, 1e-3).add(toObstacle.r * direction, 1e-4).add(distance, 1e-2).add(tolerance, 1e-3);
  for (const Zone& z : zones) key.add(toObstacle.apply(z.a), 1e-2).add(toObstacle.apply(z.b), 1e-2).add(z.radius, 1e-2);
  {
    std::lock_guard<std::mutex> lock(s.memoLock);
    const auto it = s.memo.find(key);
    if (it != s.memo.end()) return it->second;
  }
  // Where the two first cross, however briefly (firstCrossing), while they can cross at all; it
  // stops `tolerance` short of there. A stretch of the way is looked at in one go, so that two
  // pieces passing without touching cost one look; the stretches grow as the way stays clear,
  // so that a hit near the start costs little too.
  const double lo = std::max(0.0, enter - kSweepStep), hi = std::min(distance, leave + kSweepStep);
  double result = distance;
  for (double begin = lo, stretch = 8 * kSweepStep; begin < hi; begin += stretch, stretch *= 4) {
    const double length = std::min(stretch, hi - begin);
    Xform at = from;
    at.t = at.t + direction * begin;
    const double first = firstCrossing(*s.shapes[p], at, direction, length, *s.shapes[q], s.poses[q], zones);
    if (!(first <= length)) continue;
    result = std::max(0.0, begin + first - tolerance);
    break;
  }
  std::lock_guard<std::mutex> lock(s.memoLock);
  s.memo.emplace(key, result);
  return result;
}

double World::clearTravel(const std::vector<uint32_t>& unit, Vec3 direction, double distance, const Present* present, const std::vector<Zone>& zones, uint32_t* blocker, const Xform& start, double tolerance, double enough) const {
  const State& s = *state_;
  if (blocker) *blocker = UINT32_MAX;
  if (!(distance > 0) || !(length(direction) > 0)) return 0;
  direction = normalized(direction);
  double best = distance;
  std::vector<uint32_t> found;
  for (uint32_t p : unit) {
    if (p >= s.shapes.size() || s.shapes[p]->nodes.empty()) continue;
    const Xform from = start * s.poses[p];
    const Box startBox = s.shapes[p]->bounds.transformed(from);
    Box swept = startBox;
    swept.grow(startBox.min + direction * distance);
    swept.grow(startBox.max + direction * distance);
    near(swept, present, found);
    // Nearest along the way first, so that what stops it is met early; what its box cannot
    // reach before the best so far cannot stop it sooner.
    auto reach = [&](uint32_t q) {
      const Box& ob = s.boxes[q];
      const double lo[3] = {startBox.min.x, startBox.min.y, startBox.min.z}, hi[3] = {startBox.max.x, startBox.max.y, startBox.max.z};
      const double olo[3] = {ob.min.x, ob.min.y, ob.min.z}, ohi[3] = {ob.max.x, ob.max.y, ob.max.z};
      const double d[3] = {direction.x, direction.y, direction.z};
      double enter = 0;
      for (int i = 0; i < 3; i++) {
        if (std::abs(d[i]) < 1e-12) continue;
        enter = std::max(enter, std::min((olo[i] - hi[i]) / d[i], (ohi[i] - lo[i]) / d[i]));
      }
      return enter;
    };
    std::vector<std::pair<double, uint32_t>> ordered;
    for (uint32_t q : found) ordered.emplace_back(reach(q), q);
    std::sort(ordered.begin(), ordered.end());
    // First, cheaply: a point a skin inside the piece that passes through another's surface
    // means the piece is stopped by then. Asked only whether it gets as far as `enough`, that
    // settles it; otherwise it bounds how far the sweeps below need to look.
    if (s.probes[p]) {
      for (const Vec3& local : *s.probes[p]) {
        const double reachTo = enough > 0 ? enough : best;
        const Vec3 a = from.apply(local), b = a + direction * reachTo;
        Box way;
        way.grow(a), way.grow(b);
        // The nearest surface it passes through stops it. Pieces come in the order their boxes
        // are met, which is not the order their surfaces are: one whose box is met first may be
        // passed into later than another. Only a piece whose box is met before the nearest so
        // far can be nearer still.
        double nearest = 1;  // as a share of reachTo
        uint32_t by = UINT32_MAX;
        for (const auto& [enter, q] : ordered) {
          if (enter > nearest * reachTo) break;
          if (!boxesMeet(way, s.boxes[q]) || std::binary_search(unit.begin(), unit.end(), q)) continue;
          Vec3 where;
          const double share = throughSurface(*s.shapes[q], s.poses[q], a, b, &where);
          if (share > 1 || (by != UINT32_MAX && share >= nearest)) continue;
          bool exempt = false;
          for (const Zone& z : zones) exempt = exempt || (lets(z, p, q) && inside(z, where));
          if (!exempt && boxesMeet(s.boxes[p], s.boxes[q])) {
            const std::optional<std::vector<Zone>> rest = restSpots(p, q, zones);
            exempt = !rest;
            if (rest)
              for (const Zone& z : *rest) exempt = exempt || inside(z, where);
          }
          if (exempt) continue;
          nearest = share, by = q;
          if (enough > 0) break;  // asked only whether it gets that far: any surface settles it
        }
        if (by == UINT32_MAX) continue;
        // Short of it by the tolerance, as for a crossing: stopped right on the surface, the
        // next leg would start where rounding decides which side of it the point is.
        const double stop = std::max(0.0, nearest * reachTo - tolerance);
        if (blocker) *blocker = by;
        if (enough > 0) return stop;
        best = std::min(best, stop);
      }
    }
    for (const auto& [enter, q] : ordered) {
      if (enter > best) break;
      if (std::binary_search(unit.begin(), unit.end(), q)) continue;
      // What already crosses it where the model has it is not this move's doing: there, and only there.
      std::optional<std::vector<Zone>> rest = std::vector<Zone>{};
      if (boxesMeet(s.boxes[p], s.boxes[q])) rest = restSpots(p, q, zones);
      if (!rest) continue;
      std::vector<Zone> withRest;
      if (!rest->empty()) withRest = zones, withRest.insert(withRest.end(), rest->begin(), rest->end());
      const double got = pairTravel(p, from, startBox, q, direction, best, rest->empty() ? zones : withRest, tolerance);  // no further than it is known to get
      if (got < best) {
        best = got;
        if (blocker) *blocker = q;
        if (best < enough) return best;  // it does not get as far as it must: no need to know more
      }
    }
  }
  return best;
}

std::optional<std::vector<Zone>> World::restSpots(uint32_t p, uint32_t q, const std::vector<Zone>& allZones) const {
  constexpr double kSpot = 2;    // LDU round each place they cross
  constexpr int kMostSpots = 24;  // more than this: a squeeze, not a few grazes
  const State& s = *state_;
  std::vector<Zone> zones = zonesNear(allZones, p, q, s.boxes[q]);
  const Xform toObstacle = inverseOf(s.poses[q]);
  const Xform rel = toObstacle * s.poses[p];
  Key key;
  key.add(3).add(reinterpret_cast<uintptr_t>(s.shapes[p].get())).add(reinterpret_cast<uintptr_t>(s.shapes[q].get()));
  for (double v : rel.r.m) key.add(v, 1e-4);
  key.add(rel.t, 1e-3);
  for (const Zone& z : zones) key.add(toObstacle.apply(z.a), 1e-2).add(toObstacle.apply(z.b), 1e-2).add(z.radius, 1e-2);
  {
    std::lock_guard<std::mutex> lock(s.memoLock);
    const auto it = s.spots.find(key);
    if (it != s.spots.end()) return it->second;
  }
  std::optional<std::vector<Zone>> found = std::vector<Zone>{};
  for (int i = 0;; i++) {
    Hit hit;
    if (!overlap(*s.shapes[p], s.poses[p], *s.shapes[q], s.poses[q], zones, &hit)) break;
    if (i == kMostSpots) {
      found.reset();
      break;
    }
    const Zone spot{hit.point, hit.point, kSpot, p, q};
    found->push_back(spot);
    zones.push_back(spot);
  }
  std::lock_guard<std::mutex> lock(s.memoLock);
  s.spots.emplace(key, found);
  return found;
}

/// Whether two pieces cross where the model has them, given the zones. Remembered like pairTravel.
bool World::restCrossing(uint32_t p, uint32_t q, const std::vector<Zone>& allZones) const {
  const State& s = *state_;
  const std::vector<Zone> zones = zonesNear(allZones, p, q, s.boxes[q]);
  const Xform toObstacle = inverseOf(s.poses[q]);
  const Xform rel = toObstacle * s.poses[p];
  Key key;
  key.add(2).add(reinterpret_cast<uintptr_t>(s.shapes[p].get())).add(reinterpret_cast<uintptr_t>(s.shapes[q].get()));
  for (double v : rel.r.m) key.add(v, 1e-4);
  key.add(rel.t, 1e-3);
  for (const Zone& z : zones) key.add(toObstacle.apply(z.a), 1e-2).add(toObstacle.apply(z.b), 1e-2).add(z.radius, 1e-2);
  {
    std::lock_guard<std::mutex> lock(s.memoLock);
    const auto it = s.memo.find(key);
    if (it != s.memo.end()) return it->second > 0;
  }
  const bool crossing = overlap(*s.shapes[p], s.poses[p], *s.shapes[q], s.poses[q], zones);
  std::lock_guard<std::mutex> lock(s.memoLock);
  s.memo.emplace(key, crossing ? 1.0 : 0.0);
  return crossing;
}

std::optional<uint32_t> World::hits(const Shape& shape, const Xform& xf, const std::vector<uint32_t>& ignore, const std::vector<Zone>& zones) const {
  if (shape.nodes.empty()) return std::nullopt;
  const Box box = shape.bounds.transformed(xf);
  if (box.empty() || !std::isfinite(box.min.x) || !std::isfinite(box.max.x)) return std::nullopt;
  const State& s = *state_;
  // Pieces whose box can reach this one start no further left than box.min.x - widest.
  auto first = std::lower_bound(s.byMinX.begin(), s.byMinX.end(), box.min.x - s.widest, [&](uint32_t i, double x) { return s.boxes[i].min.x < x; });
  std::optional<uint32_t> best;
  const bool named = std::any_of(zones.begin(), zones.end(), [](const Zone& z) { return z.first != kAnyPiece; });
  std::vector<Zone> mine;
  for (auto it = first; it != s.byMinX.end() && s.boxes[*it].min.x <= box.max.x; ++it) {
    const uint32_t i = *it;
    if (best && i > *best) continue;  // report the lowest piece index, whatever the scan order
    if (!boxesMeet(box, s.boxes[i]) || std::find(ignore.begin(), ignore.end(), i) != ignore.end()) continue;
    if (named) {  // the shape is none of the model's pieces
      mine.clear();
      for (const Zone& z : zones)
        if (lets(z, kAnyPiece, i)) mine.push_back(z);
    }
    if (overlap(shape, xf, *s.shapes[i], s.poses[i], named ? mine : zones)) best = i;
  }
  return best;
}

std::optional<double> World::sweep(const Shape& shape, const Xform& from, const Xform& to, const std::vector<uint32_t>& ignore, const std::vector<Zone>& zones) const {
  if (shape.nodes.empty()) return std::nullopt;
  // How far any point of the shape travels: the straight move plus the arc its far corner turns through.
  Vec3 axis;
  double angle = 0;
  const bool turns = std::abs(determinant(from.r)) > 1e-9 && axisAngle(from.r.m[0] == to.r.m[0] && from.r.m[4] == to.r.m[4] && from.r.m[8] == to.r.m[8] && from.r.m[1] == to.r.m[1] ? Mat3::identity() : bm::inverse(from.r) * to.r, axis, angle) && angle > 0;
  double reach = 0;
  for (double v : {shape.bounds.min.x, shape.bounds.max.x, shape.bounds.min.y, shape.bounds.max.y, shape.bounds.min.z, shape.bounds.max.z}) reach = std::max(reach, std::abs(v));
  const double travel = length(to.t - from.t) + (turns ? angle * reach * 1.7321 : 0);
  if (!std::isfinite(travel)) return std::nullopt;
  const int steps = std::max(1, std::min(kMaxSweepSteps, static_cast<int>(std::ceil(travel / kSweepStep))));
  for (int i = 0; i <= steps; i++) {
    const double u = static_cast<double>(i) / steps;
    Xform pose;
    pose.t = from.t + (to.t - from.t) * u;
    pose.r = turns ? from.r * rotation(axis, angle * u) : (i == steps ? to.r : from.r);
    if (hits(shape, pose, ignore, zones)) return u;
  }
  return std::nullopt;
}

}  // namespace bm::collide
