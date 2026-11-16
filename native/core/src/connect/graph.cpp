#include "bm/connect/graph.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_map>
#include "bm/collide/tolerances.h"
#include "bm/connect/tolerances.h"

namespace bm::connect {
namespace {

// Points are entered into the hash this far apart along a connector, and each point is
// entered into every cell within kReach of it. Two mated connectors share an axis to within
// kAxisOffset, so some pair of their points is within kSampleStep/2 + kAxisOffset < kReach.
constexpr double kSampleStep = 8.0;
constexpr double kReach = 6.0;

struct Placed {
  Connector connector;
  uint32_t piece;
};

uint64_t cellKey(int64_t x, int64_t y, int64_t z) {
  // 21 bits per axis: +-16,000,000 LDU at a 16 LDU cell. Models are far smaller.
  const uint64_t mask = (1ull << 21) - 1;
  return ((static_cast<uint64_t>(x) & mask) << 42) | ((static_cast<uint64_t>(y) & mask) << 21) | (static_cast<uint64_t>(z) & mask);
}

struct UnionFind {
  std::vector<uint32_t> parent;
  explicit UnionFind(size_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0u); }
  uint32_t find(uint32_t i) {
    while (parent[i] != i) i = parent[i] = parent[parent[i]];
    return i;
  }
  void join(uint32_t a, uint32_t b) { parent[find(a)] = find(b); }
  /// Renumbers the sets 0..n-1 in order of first appearance; returns the count.
  uint32_t label(std::vector<uint32_t>& out) {
    std::unordered_map<uint32_t, uint32_t> ids;
    out.resize(parent.size());
    for (uint32_t i = 0; i < parent.size(); i++) out[i] = ids.emplace(find(i), static_cast<uint32_t>(ids.size())).first->second;
    return static_cast<uint32_t>(ids.size());
  }
};

/// Pieces that are exact duplicates of one another get the same number.
std::vector<uint32_t> twins(const Model& model) {
  std::vector<uint32_t> out(model.pieces().size());
  std::unordered_map<std::string, uint32_t> seen;
  for (uint32_t i = 0; i < out.size(); i++) {
    const Piece& p = model.pieces()[i];
    std::string key = p.part;
    auto add = [&](double v) { key += ' ' + std::to_string(std::llround(v * 1000)); };
    add(p.world.t.x);
    add(p.world.t.y);
    add(p.world.t.z);
    for (double v : p.world.r.m) add(v);
    out[i] = seen.emplace(std::move(key), i).first->second;
  }
  return out;
}

bool hasWord(std::string text, const char* word) {
  for (char& c : text)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return text.find(word) != std::string::npos;
}

/// Whether a placed "part" is really a stretch of a flexible element or a bare primitive.
/// The library says so itself: a primitive lives under p/, and a part that is not meant to
/// be used alone has a description starting with '~' ("~Hose Flexible Segment",
/// "~Electric Cable 3LDU Twin"). Files
/// that tools generate inside a model for bent hoses and cables are named by their segment
/// type ("LS60", "...wireseg"). A "~Moved to X" file is judged by what it moved to.
bool segmentPart(const std::string& part, const ldraw::Library& lib, int depth = 0) {
  const ldraw::File* file = lib.find(part);
  if (!file) return false;
  if (!lib.isInline(part)) {
    if (const auto path = lib.resolve(part)) {
      const std::string dir = path->parent_path().generic_string();
      if (dir.size() >= 2 && (dir.find("/p/") != std::string::npos || dir.compare(dir.size() - 2, 2, "/p") == 0)) return true;
    }
  }
  const std::string& d = file->description;
  if (d.rfind("~Moved to", 0) == 0) {
    for (const ldraw::Command& c : file->cmds)
      if (c.type == ldraw::Cmd::Ref) return depth < 8 && segmentPart(c.file, lib, depth + 1);
    return false;
  }
  if (!d.empty() && d[0] == '~') return true;
  if (hasWord(d, "segment") || hasWord(part, "wireseg")) return true;
  if (lib.isInline(part)) {
    // Generated hose and cable stretches: "<set> - ls70.dat", or described as "LS70".
    const size_t at = part.rfind(" - ");
    const std::string tail = at == std::string::npos ? part : part.substr(at + 3);
    auto lsynth = [](const std::string& t) { return t.size() >= 3 && (t[0] == 'l' || t[0] == 'L') && (t[1] == 's' || t[1] == 'S') && t[2] >= '0' && t[2] <= '9'; };
    if (lsynth(tail) || lsynth(d)) return true;
  }
  return false;
}

/// Where the teeth of a mesh interleave: the lens the two tip circles share, the length of
/// the shared tooth width.
MateZone meshZone(const kin::GearMesh& m) {
  const double tip = collide::kToothReach;
  auto offLine = [](Vec3 p, Vec3 origin, Vec3 axis) {
    const Vec3 v = p - origin;
    return length(v - axis * dot(v, axis));
  };
  const double ra = offLine(m.point, m.pointA, m.axisA);
  double half = 0;
  if (m.kind == kin::MeshKind::Rack) {
    half = std::sqrt(4 * ra * tip);  // a circle of ra + tip over a line ra - tip from its centre
    // A capsule along the rack, wide enough to take in the teeth across the gear's width.
    return {m.point - m.tangent * half, m.point + m.tangent * half, std::hypot(tip, m.width / 2) + collide::kZonePad};
  }
  const double rb = m.kind == kin::MeshKind::Worm ? ra : offLine(m.point, m.pointB, m.axisB);
  const double A = ra + tip, B = rb + tip, d = ra + rb;
  const double x = (d * d + A * A - B * B) / (2 * d);
  half = std::sqrt(std::max(0.0, A * A - x * x));
  const Vec3 along = m.axisA * (m.width / 2);
  return {m.point - along, m.point + along, half + collide::kZonePad};
}

}  // namespace

Graph buildGraph(const Model& model, ConnectorDb& db, const kin::GearDb* gears) {
  const std::vector<Piece>& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  Graph g;
  g.hasConnectors.assign(n, 0);
  g.isSegment.assign(n, 0);
  {
    std::unordered_map<std::string, bool> known;
    for (uint32_t i = 0; i < n; i++) {
      auto it = known.find(pieces[i].part);
      if (it == known.end()) it = known.emplace(pieces[i].part, segmentPart(pieces[i].part, model.library())).first;
      g.isSegment[i] = it->second;
      g.segments += it->second;
    }
  }

  // Every connector of every piece, in model space.
  std::vector<Placed> placed;
  std::unordered_map<std::string, std::shared_ptr<const std::vector<Connector>>> byPart;
  for (uint32_t i = 0; i < n; i++) {
    auto it = byPart.find(pieces[i].part);
    if (it == byPart.end()) it = byPart.emplace(pieces[i].part, db.get(pieces[i].part, &model.library())).first;
    if (it->second->empty()) {
      g.withoutConnectors++;
      continue;
    }
    g.hasConnectors[i] = 1;
    for (const Connector& c : *it->second) placed.push_back({transformed(c, pieces[i].world), i});
  }

  // Spatial hash: (cell, connector) entries, sorted by cell.
  std::vector<std::pair<uint64_t, uint32_t>> entries;
  entries.reserve(placed.size() * 3);
  std::vector<uint64_t> cells;
  for (uint32_t ci = 0; ci < placed.size(); ci++) {
    const Connector& c = placed[ci].connector;
    cells.clear();
    const int steps = std::max(1, static_cast<int>(std::ceil(c.length / kSampleStep)));
    for (int s = 0; s <= steps; s++) {
      const Vec3 p = c.start + c.axis * (c.length * s / steps);
      for (int corner = 0; corner < 8; corner++) {
        const Vec3 q{p.x + (corner & 1 ? kReach : -kReach), p.y + (corner & 2 ? kReach : -kReach), p.z + (corner & 4 ? kReach : -kReach)};
        cells.push_back(cellKey(static_cast<int64_t>(std::floor(q.x / kHashCell)), static_cast<int64_t>(std::floor(q.y / kHashCell)), static_cast<int64_t>(std::floor(q.z / kHashCell))));
      }
    }
    std::sort(cells.begin(), cells.end());
    cells.erase(std::unique(cells.begin(), cells.end()), cells.end());
    for (uint64_t cell : cells) entries.emplace_back(cell, ci);
  }
  std::sort(entries.begin(), entries.end());

  // Candidate connector pairs: those sharing a cell, on different pieces that are not twins.
  const std::vector<uint32_t> twin = twins(model);
  std::vector<uint64_t> candidates;
  for (size_t lo = 0; lo < entries.size();) {
    size_t hi = lo;
    while (hi < entries.size() && entries[hi].first == entries[lo].first) hi++;
    for (size_t i = lo; i < hi; i++)
      for (size_t j = i + 1; j < hi; j++) {
        const uint32_t a = entries[i].second, b = entries[j].second;
        const uint32_t pa = placed[a].piece, pb = placed[b].piece;
        if (pa == pb || twin[pa] == twin[pb]) continue;
        candidates.push_back((static_cast<uint64_t>(a) << 32) | b);  // a < b: entries are sorted
      }
    lo = hi;
  }
  std::sort(candidates.begin(), candidates.end());
  candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());

  // Mates, gathered per piece pair.
  struct Pair {
    std::vector<Freedom> freedoms;
    std::vector<MateZone> zones;
    double grip = 0;
  };
  // The volume a mate occupies: along the shorter of the two connectors (the clip, not the
  // whole bar it holds), a little wider than the wider of them.
  auto zoneOf = [](const Connector& x, const Connector& y) {
    auto elastic = [](const Connector& c) { return (!c.profile.empty() && c.profile[0].shape == 'T') || c.group.rfind("studio-wheel-", 0) == 0; };
    if (elastic(x) || elastic(y)) return MateZone{x.start, x.start, collide::kElasticZone};
    if (x.kind == SnapKind::Generic || y.kind == SnapKind::Generic) return MateZone{x.start, y.start, std::max({x.radius, y.radius, collide::kGenericZone}) + collide::kZonePad};
    const Connector& s = x.length <= y.length ? x : y;
    return MateZone{s.start, s.start + s.axis * s.length, std::max(x.radius, y.radius) + collide::kZonePad};
  };
  std::unordered_map<uint64_t, Pair> pairs;
  for (uint64_t key : candidates) {
    const Placed& a = placed[key >> 32];
    const Placed& b = placed[key & 0xFFFFFFFFu];
    const std::optional<Mate> m = mate(a.connector, b.connector);
    if (!m) continue;
    const uint32_t lo = std::min(a.piece, b.piece), hi = std::max(a.piece, b.piece);
    Pair& pair = pairs[(static_cast<uint64_t>(lo) << 32) | hi];
    pair.freedoms.push_back(m->freedom);
    pair.zones.push_back(zoneOf(a.connector, b.connector));
    pair.grip += m->grip;
  }

  UnionFind groups(n), bodies(n);
  std::vector<uint8_t> attached(n, 0);
  g.connections.reserve(pairs.size());
  for (auto& [key, pair] : pairs) {
    Connection c;
    c.a = static_cast<uint32_t>(key >> 32);
    c.b = static_cast<uint32_t>(key & 0xFFFFFFFFu);
    c.joint = combine(pair.freedoms);
    c.friction = std::any_of(pair.freedoms.begin(), pair.freedoms.end(), [](const Freedom& f) { return f.friction; });
    c.mates = static_cast<uint16_t>(std::min<size_t>(pair.freedoms.size(), 65535));
    c.grip = pair.grip;
    c.firstZone = static_cast<uint32_t>(g.zones.size());
    c.zoneCount = static_cast<uint32_t>(pair.zones.size());
    g.zones.insert(g.zones.end(), pair.zones.begin(), pair.zones.end());
    groups.join(c.a, c.b);
    if (c.joint.kind == JointKind::Fixed) bodies.join(c.a, c.b);
    attached[c.a] = attached[c.b] = 1;
    g.connections.push_back(c);
  }
  // Flexible elements. A bent hose or cable is stored as a run of short segment pieces, one
  // after another in the file. The run is one element: its segments are chained, and each end
  // is attached to the part it meets there (the piece next to it in the file if that is close,
  // otherwise whichever part has a connector at the end).
  auto flex = [&](uint32_t a, uint32_t b) {
    Connection c;
    c.a = std::min(a, b);
    c.b = std::max(a, b);
    c.joint.kind = JointKind::Flexible;
    c.joint.point = pieces[b].world.t;
    c.joint.axis = {0, -1, 0};
    groups.join(a, b);
    attached[a] = attached[b] = 1;
    g.connections.push_back(c);
  };
  auto near = [&](uint32_t a, uint32_t b, double reach) { return length(pieces[a].world.t - pieces[b].world.t) <= reach; };
  auto attachEnd = [&](uint32_t end, uint32_t neighbour, bool haveNeighbour) {
    if (haveNeighbour && !g.isSegment[neighbour] && pieces[neighbour].path == pieces[end].path && near(end, neighbour, kSegmentGap)) {
      flex(end, neighbour);
      return;
    }
    double best = kSegmentReach;
    uint32_t who = n;
    for (const Placed& p : placed) {
      if (g.isSegment[p.piece]) continue;
      const double d = std::min(length(p.connector.start - pieces[end].world.t), length(p.connector.start + p.connector.axis * p.connector.length - pieces[end].world.t));
      if (d < best) {
        best = d;
        who = p.piece;
      }
    }
    if (who != n) flex(end, who);
  };
  for (uint32_t i = 0; i < n;) {
    if (!g.isSegment[i]) {
      i++;
      continue;
    }
    uint32_t last = i;
    while (last + 1 < n && g.isSegment[last + 1] && pieces[last + 1].path == pieces[i].path && near(last, last + 1, kSegmentGap)) {
      flex(last, last + 1);
      last++;
    }
    if (last > i) g.flexibleRuns++;
    attachEnd(i, i - 1, i > 0);
    attachEnd(last, last + 1, last + 1 < n);
    i = last + 1;
  }

  std::sort(g.connections.begin(), g.connections.end(), [](const Connection& x, const Connection& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });

  // An element's end can reach the same part by both routes; keep one connection per pair.
  g.connections.erase(std::unique(g.connections.begin(), g.connections.end(), [](const Connection& x, const Connection& y) { return x.a == y.a && x.b == y.b; }), g.connections.end());

  g.groups = groups.label(g.group);
  g.bodies = bodies.label(g.body);
  std::vector<uint32_t> sizes(g.groups, 0);
  for (uint32_t id : g.group) sizes[id]++;
  for (uint32_t s : sizes) g.largestGroup = std::max(g.largestGroup, s);
  std::vector<uint32_t> partSizes(g.groups, 0);
  for (uint32_t i = 0; i < n; i++)
    if (!g.isSegment[i]) partSizes[g.group[i]]++;
  for (uint32_t s : partSizes) g.largestGroupParts = std::max(g.largestGroupParts, s);
  g.attached = static_cast<uint32_t>(std::count(attached.begin(), attached.end(), 1));
  if (gears) {
    g.meshes = kin::findMeshes(model, *gears);
    g.meshZones.reserve(g.meshes.size());
    for (const kin::GearMesh& m : g.meshes) g.meshZones.push_back(meshZone(m));
  }
  return g;
}

std::vector<NearMiss> nearMisses(const Model& model, ConnectorDb& db, uint32_t piece, double within, size_t limit) {
  std::vector<NearMiss> out;
  const std::vector<Piece>& pieces = model.pieces();
  if (piece >= pieces.size()) return out;
  std::vector<Connector> mine;
  for (const Connector& c : *db.get(pieces[piece].part, &model.library())) mine.push_back(transformed(c, pieces[piece].world));
  // A linear scan: this is a diagnostic for single pieces, not part of building the graph.
  for (uint32_t i = 0; i < pieces.size(); i++) {
    if (i == piece) continue;
    const auto theirs = db.get(pieces[i].part, &model.library());
    for (const Connector& raw : *theirs) {
      const Connector c = transformed(raw, pieces[i].world);
      for (const Connector& m : mine) {
        // Closest approach of the two connector segments' ends, cheaply: start to start, start to end.
        const double d = std::min({length(c.start - m.start), length(c.start + c.axis * c.length - m.start), length(c.start - (m.start + m.axis * m.length))});
        if (d > within) continue;
        const std::string why = whyNot(m, c);
        if (why.empty() || why == "same gender") continue;
        out.push_back({i, d, why});
      }
    }
  }
  std::sort(out.begin(), out.end(), [](const NearMiss& a, const NearMiss& b) { return a.distance < b.distance; });
  if (out.size() > limit) out.resize(limit);
  return out;
}

}  // namespace bm::connect
