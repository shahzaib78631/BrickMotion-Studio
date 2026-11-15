#include "bm/connect/graph.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_map>
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

}  // namespace

Graph buildGraph(const Model& model, ConnectorDb& db) {
  const std::vector<Piece>& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  Graph g;
  g.hasConnectors.assign(n, 0);

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
    double grip = 0;
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
    c.mates = static_cast<uint16_t>(std::min<size_t>(pair.freedoms.size(), 65535));
    c.grip = pair.grip;
    groups.join(c.a, c.b);
    if (c.joint.kind == JointKind::Fixed) bodies.join(c.a, c.b);
    attached[c.a] = attached[c.b] = 1;
    g.connections.push_back(c);
  }
  std::sort(g.connections.begin(), g.connections.end(), [](const Connection& x, const Connection& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });

  g.groups = groups.label(g.group);
  g.bodies = bodies.label(g.body);
  std::vector<uint32_t> sizes(g.groups, 0);
  for (uint32_t id : g.group) sizes[id]++;
  for (uint32_t s : sizes) g.largestGroup = std::max(g.largestGroup, s);
  g.attached = static_cast<uint32_t>(std::count(attached.begin(), attached.end(), 1));
  return g;
}

}  // namespace bm::connect
