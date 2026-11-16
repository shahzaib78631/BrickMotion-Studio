#include "bm/plan/plan.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <numeric>
#include "bm/plan/tolerances.h"

namespace bm::plan {
namespace {

using collide::World;
using connect::Connection;

Unit unitOf(std::vector<uint32_t> pieces) {
  std::sort(pieces.begin(), pieces.end());
  pieces.erase(std::unique(pieces.begin(), pieces.end()), pieces.end());
  return {std::move(pieces)};
}

/// Whether the present pieces of `set`, without `unit`, are still joined to each other.
bool staysJoined(const Context& ctx, const std::vector<uint32_t>& set, const World::Present& present, const Unit& unit, std::vector<uint32_t>& stack, std::vector<uint8_t>& seen) {
  uint32_t start = UINT32_MAX;
  size_t left = 0;
  for (uint32_t p : set) {
    if (!present[p] || std::binary_search(unit.pieces.begin(), unit.pieces.end(), p)) continue;
    if (start == UINT32_MAX) start = p;
    left++;
  }
  if (left <= 1) return true;
  std::fill(seen.begin(), seen.end(), 0);
  for (uint32_t p : unit.pieces) seen[p] = 1;
  stack.assign(1, start);
  seen[start] = 1;
  size_t reached = 0;
  while (!stack.empty()) {
    const uint32_t p = stack.back();
    stack.pop_back();
    reached++;
    for (uint32_t ci : ctx.connectionsOf[p]) {
      const Connection& c = ctx.graph.connections[ci];
      const uint32_t other = c.a == p ? c.b : c.a;
      if (seen[other] || !present[other]) continue;
      seen[other] = 1;
      stack.push_back(other);
    }
  }
  return reached == left;
}

struct Sequencer {
  const Context& ctx;
  const Units& units;
  const Options& options;
  JobPool& pool;
  std::chrono::steady_clock::time_point started;
  size_t extractions = 0;
  bool stopped = false;

  bool outOfTime() {
    if (stopped) return true;
    if (options.cancel && options.cancel->cancelled()) stopped = true;
    if (options.budgetSeconds > 0 && std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count() > options.budgetSeconds) stopped = true;
    return stopped;
  }
  Vec3 authoredAxis(uint32_t piece) const {
    if (!options.authored || piece >= options.authored->insertionAxis.size()) return {};
    return options.authored->insertionAxis[piece];
  }

  /// Takes `set` (joined pieces, or all of a unit's) apart; `out` gets the moves in build order.
  /// `depth` bounds how far units of units go.
  void takeApart(const std::vector<uint32_t>& set, Plan& out, int depth, const World::Present* built = nullptr) {
    const size_t n = ctx.model.pieces().size();
    // What was built before this set stands where it is the whole time, in the way like anything else.
    World::Present present = built ? *built : World::Present(n, 0);
    Box bounds;
    for (uint32_t p = 0; p < n; p++)
      if (present[p]) bounds.merge(ctx.world.box(p));
    Vec3 centre{};
    for (uint32_t p : set) {
      present[p] = 1;
      bounds.merge(ctx.world.box(p));
    }
    if (!bounds.empty()) centre = (bounds.min + bounds.max) * 0.5;
    size_t left = set.size();
    std::vector<Extraction> single(n);
    std::vector<uint8_t> dirty(n, 0), seen(n, 0);
    std::vector<uint32_t> stack, todo;
    for (uint32_t p : set) dirty[p] = 1;
    // What must be built after what (the author's), as "cannot be removed while these are present".
    std::vector<std::vector<uint32_t>> removeFirst(n);
    if (options.authored) {
      for (const auto& [first, second] : options.authored->after)
        if (first < n && second < n) removeFirst[first].push_back(second);
      for (const std::vector<uint32_t>& order : options.authored->pinned)
        for (size_t i = 0; i + 1 < order.size(); i++)
          if (order[i] < n && order[i + 1] < n) removeFirst[order[i]].push_back(order[i + 1]);
    }
    auto free = [&](const Unit& u) {
      for (uint32_t p : u.pieces)
        for (uint32_t later : removeFirst[p])
          if (present[later] && !std::binary_search(u.pieces.begin(), u.pieces.end(), later)) return false;
      return true;
    };
    std::vector<Move> removed;  // in the order taken off
    const Piece* last = nullptr;
    auto take = [&](Unit unit, UnitSource source, const Extraction& e, Flag flag) {
      Move m;
      m.unit = std::move(unit);
      m.source = source;
      m.insertion = -e.direction;
      m.seatTravel = e.seatTravel;
      m.path = flag == Flag::None ? e.path : std::vector<Xform>{};
      m.flag = flag;
      m.blocker = e.blocker;
      for (uint32_t p : m.unit.pieces) {
        present[p] = 0;
        left--;
        for (uint32_t ci : ctx.connectionsOf[p]) {
          const Connection& c = ctx.graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (present[other]) dirty[other] = 1;
        }
      }
      for (uint32_t q : set)
        if (present[q] && !single[q].ok && single[q].blocker != UINT32_MAX && std::binary_search(m.unit.pieces.begin(), m.unit.pieces.end(), single[q].blocker)) dirty[q] = 1;
      last = &ctx.model.pieces()[m.unit.pieces.front()];
      removed.push_back(std::move(m));
    };
    // The reverse of how it should be built: continue the run, later steps first, top first, outside first.
    auto before = [&](uint32_t a, uint32_t b) {
      const Piece &pa = ctx.model.pieces()[a], &pb = ctx.model.pieces()[b];
      if (last) {
        const bool ra = pa.path == last->path, rb = pb.path == last->path;
        if (ra != rb) return ra;
      }
      if (pa.step != pb.step) return pa.step > pb.step;
      const Box &ba = ctx.world.box(a), &bb = ctx.world.box(b);
      const double ha = -dot(ctx.down, (ba.min + ba.max) * 0.5), hb = -dot(ctx.down, (bb.min + bb.max) * 0.5);
      if (std::abs(ha - hb) > 1) return ha > hb;
      auto radial = [&](const Box& box) {
        const Vec3 v = (box.min + box.max) * 0.5 - centre;
        return length(v - ctx.down * dot(v, ctx.down));
      };
      const double oa = radial(ba), ob = radial(bb);
      if (std::abs(oa - ob) > 1) return oa > ob;
      return a < b;
    };

    while (left > 0) {
      if (outOfTime()) {
        for (uint32_t p : set)
          if (present[p]) take(unitOf({p}), UnitSource::Piece, {}, Flag::Budget);
        break;
      }
      // Try again whatever has changed around it.
      todo.clear();
      for (uint32_t p : set)
        if (present[p] && dirty[p]) todo.push_back(p), dirty[p] = 0;
      pool.parallelFor(todo.size(), [&](size_t i) {
        const uint32_t p = todo[i];
        single[p] = extract(ctx, unitOf({p}), &present, bounds, authoredAxis(p), false);
      });
      extractions += todo.size();
      // The best piece that can leave without splitting what is left.
      std::vector<uint32_t> ready;
      for (uint32_t p : set)
        if (present[p] && single[p].ok) ready.push_back(p);
      std::sort(ready.begin(), ready.end(), before);
      bool took = false;
      for (uint32_t p : ready) {
        const Unit u = unitOf({p});
        if (!free(u) || !staysJoined(ctx, set, present, u, stack, seen)) continue;
        take(u, UnitSource::Piece, single[p], Flag::None);
        took = true;
        break;
      }
      if (took) continue;
      std::vector<uint32_t> stuck;
      for (uint32_t p : set)
        if (present[p]) stuck.push_back(p);
      std::sort(stuck.begin(), stuck.end(), before);
      // Nothing leaves by a straight way out. Those that do leave their seats: a way out with a turn in it.
      todo.clear();
      for (uint32_t p : stuck)
        if (single[p].why == Flag::NoExit) todo.push_back(p);
      std::vector<Extraction> turned(todo.size());
      pool.parallelFor(todo.size(), [&](size_t i) { turned[i] = extract(ctx, unitOf({todo[i]}), &present, bounds, authoredAxis(todo[i]), true); });
      extractions += todo.size();
      for (size_t i = 0; i < todo.size() && !took; i++) {
        const Unit u = unitOf({todo[i]});
        if (!turned[i].ok || !free(u) || !staysJoined(ctx, set, present, u, stack, seen)) continue;
        take(u, UnitSource::Piece, turned[i], Flag::None);
        took = true;
      }
      if (took) continue;
      // Nothing leaves alone: pieces that must go in together.
      for (uint32_t p : stuck) {
        if (took || outOfTime()) break;
        std::vector<std::pair<Unit, UnitSource>> tries;
        auto whole = [&](const Unit& u) { return u.pieces.size() < left && std::all_of(u.pieces.begin(), u.pieces.end(), [&](uint32_t q) { return present[q] != 0; }); };
        if (depth < 4) {
          for (uint32_t gi : units.authoredOf[p])
            if (whole(units.authored[gi])) tries.emplace_back(units.authored[gi], UnitSource::Authored);
          for (uint32_t gi : units.bodyOf[p])
            if (whole(units.bodies[gi])) tries.emplace_back(units.bodies[gi], UnitSource::Body);
          Unit grown = growUnit(ctx, p, &present);
          if (grown.pieces.size() > 1 && grown.pieces.size() < left) tries.emplace_back(std::move(grown), UnitSource::Grown);
        }
        for (auto& [u, source] : tries) {
          if (!free(u) || !staysJoined(ctx, set, present, u, stack, seen)) continue;
          const Extraction e = extract(ctx, u, &present, bounds);
          extractions++;
          if (!e.ok) continue;
          take(u, source, e, Flag::None);
          took = true;
          break;
        }
      }
      if (took) continue;
      // Still nothing: the engine cannot show how this piece goes in, and says so on it.
      for (uint32_t p : stuck) {
        const Unit u = unitOf({p});
        if (!staysJoined(ctx, set, present, u, stack, seen)) continue;
        take(u, UnitSource::Piece, single[p], single[p].why == Flag::None ? Flag::Blocked : single[p].why);
        took = true;
        break;
      }
      if (!took) {  // cannot happen for a joined set: some piece is always not a cut piece
        const uint32_t p = stuck.front();
        take(unitOf({p}), UnitSource::Piece, single[p], Flag::Blocked);
      }
    }
    std::reverse(removed.begin(), removed.end());
    for (Move& m : removed) {
      if (m.unit.pieces.size() > 1 && depth < 4) {
        m.sub = static_cast<int>(out.subs.size());
        out.subs.emplace_back();
        Plan sub;
        takeApart(m.unit.pieces, sub, depth + 1);
        out.subs[static_cast<size_t>(m.sub)] = std::move(sub);
      }
      out.moves.push_back(std::move(m));
    }
  }
};

}  // namespace

Units findUnits(const Model& model, const connect::Graph& graph) {
  Units out;
  const auto& pieces = model.pieces();
  const uint32_t n = static_cast<uint32_t>(pieces.size());
  out.authoredOf.resize(n);
  out.bodyOf.resize(n);
  // Every use of a submodel: the pieces that share a path prefix. Deepest first, so smallest first.
  std::map<std::vector<std::string>, std::vector<uint32_t>> byPath;
  for (uint32_t i = 0; i < n; i++)
    for (size_t depth = pieces[i].path.size(); depth >= 1; depth--) byPath[std::vector<std::string>(pieces[i].path.begin(), pieces[i].path.begin() + static_cast<long>(depth))].push_back(i);
  std::vector<Unit> authored;
  for (auto& [path, list] : byPath)
    if (list.size() > 1 && list.size() < n) authored.push_back({list});
  std::sort(authored.begin(), authored.end(), [](const Unit& a, const Unit& b) { return a.pieces.size() != b.pieces.size() ? a.pieces.size() < b.pieces.size() : a.pieces < b.pieces; });
  authored.erase(std::unique(authored.begin(), authored.end(), [](const Unit& a, const Unit& b) { return a.pieces == b.pieces; }), authored.end());
  out.authored = std::move(authored);
  for (uint32_t g = 0; g < out.authored.size(); g++)
    for (uint32_t p : out.authored[g].pieces) out.authoredOf[p].push_back(g);
  // Rigid bodies of more than one piece.
  std::map<uint32_t, std::vector<uint32_t>> byBody;
  for (uint32_t i = 0; i < n && i < graph.body.size(); i++) byBody[graph.body[i]].push_back(i);
  for (auto& [id, list] : byBody) {
    if (list.size() < 2 || list.size() >= n) continue;
    for (uint32_t p : list) out.bodyOf[p].push_back(static_cast<uint32_t>(out.bodies.size()));
    out.bodies.push_back({list});
  }
  return out;
}

Unit growUnit(const Context& ctx, uint32_t piece, const World::Present* present) {
  auto there = [&](uint32_t p) { return !present || (p < present->size() && (*present)[p]); };
  Unit unit{{piece}};
  while (static_cast<int>(unit.pieces.size()) < kMaxGroup) {
    if (unit.pieces.size() > 1 && !leaveDirections(ctx, unit, present).empty()) return unit;
    // The neighbour that ties it down least to the rest: the one with the fewest other joints.
    uint32_t best = UINT32_MAX;
    size_t bestTies = 0;
    for (uint32_t p : unit.pieces)
      for (uint32_t ci : ctx.connectionsOf[p]) {
        const Connection& c = ctx.graph.connections[ci];
        const uint32_t other = c.a == p ? c.b : c.a;
        if (!there(other) || std::binary_search(unit.pieces.begin(), unit.pieces.end(), other) || c.zoneCount == 0) continue;
        size_t ties = 0;
        for (uint32_t cj : ctx.connectionsOf[other]) {
          const Connection& d = ctx.graph.connections[cj];
          const uint32_t far = d.a == other ? d.b : d.a;
          if (there(far) && !std::binary_search(unit.pieces.begin(), unit.pieces.end(), far)) ties++;
        }
        if (best == UINT32_MAX || ties < bestTies || (ties == bestTies && other < best)) best = other, bestTies = ties;
      }
    if (best == UINT32_MAX) break;
    unit.pieces.insert(std::upper_bound(unit.pieces.begin(), unit.pieces.end(), best), best);
  }
  if (unit.pieces.size() > 1 && !leaveDirections(ctx, unit, present).empty()) return unit;
  return {};
}

Plan plan(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes, const Options& options) {
  const auto started = std::chrono::steady_clock::now();
  Plan out;
  const uint32_t n = static_cast<uint32_t>(model.pieces().size());
  if (n == 0) return out;
  const World world(model, parts, shapes);
  const Context ctx(model, graph, world, options.down);
  const Units units = findUnits(model, graph);
  Sequencer seq{ctx, units, options, options.pool ? *options.pool : JobPool::shared(), started, 0, false};

  // Groups of joined pieces, largest first; what is joined to nothing comes after.
  std::map<uint32_t, std::vector<uint32_t>> groups;
  for (uint32_t i = 0; i < n; i++) groups[i < graph.group.size() ? graph.group[i] : i].push_back(i);
  std::vector<std::vector<uint32_t>> order;
  std::vector<uint32_t> loose;
  for (auto& [id, list] : groups) {
    if (list.size() == 1 && ctx.connectionsOf[list[0]].empty() && groups.size() > 1) loose.push_back(list[0]);
    else order.push_back(std::move(list));
  }
  std::sort(order.begin(), order.end(), [](const auto& a, const auto& b) { return a.size() != b.size() ? a.size() > b.size() : a.front() < b.front(); });
  World::Present built(n, 0);
  for (const std::vector<uint32_t>& set : order) {
    seq.takeApart(set, out, 0, &built);
    for (uint32_t p : set) built[p] = 1;
  }

  // A piece joined to nothing in the file cannot be put in "joined to what is built". It is set
  // down after everything else, from above if the way is clear, and says so.
  if (!loose.empty()) {
    World::Present all(n, 1);
    Box bounds;
    for (uint32_t i = 0; i < n; i++) bounds.merge(world.box(i));
    std::vector<Extraction> found(loose.size());
    seq.pool.parallelFor(loose.size(), [&](size_t i) { found[i] = extract(ctx, Unit{{loose[i]}}, &all, bounds); });
    for (size_t i = 0; i < loose.size(); i++) {
      Move m;
      m.unit = {{loose[i]}};
      m.flag = Flag::Unjoined;
      m.insertion = found[i].ok ? -found[i].direction : ctx.down;
      m.path = found[i].ok ? found[i].path : std::vector<Xform>{};
      out.moves.push_back(std::move(m));
    }
  }
  // What the author set stands. An axis is marked; a flight replaces the planner's path, and is
  // flagged if it passes through something already built.
  if (options.authored) {
    World::Present placed(n, 0);
    for (Move& m : out.moves) {
      if (m.unit.pieces.size() == 1) {
        const uint32_t p = m.unit.pieces[0];
        if (p < options.authored->insertionAxis.size() && length(options.authored->insertionAxis[p]) > 0) m.authoredAxis = true;
        if (p < options.authored->flight.size() && options.authored->flight[p].size() >= 2 && m.flag != Flag::Budget) {
          const std::vector<Xform>& flight = options.authored->flight[p];
          m.path.assign(flight.rbegin(), flight.rend());  // seat first
          m.authoredFlight = true;
          m.flag = Flag::None;
          const Vec3 in = m.path[0].t - m.path[1].t;
          if (length(in) > 0) m.insertion = normalized(in);
          for (size_t leg = m.path.size(); leg-- > 2 && m.flag == Flag::None;) {  // the seat leg is the certifier's to judge
            const Vec3 step = m.path[leg - 1].t - m.path[leg].t;
            const double len = length(step);
            if (len > 0 && world.clearTravel(m.unit.pieces, step * (1 / len), len, &placed, {}, &m.blocker, m.path[leg]) < len - kTravelTol) m.flag = Flag::AuthoredCrossing;
          }
        }
      }
      for (uint32_t p : m.unit.pieces) placed[p] = 1;
    }
  }
  out.complete = !seq.stopped;
  out.extractions = seq.extractions;
  out.planMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return out;
}

}  // namespace bm::plan
