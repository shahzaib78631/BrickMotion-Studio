#include "bm/plan/plan.h"

#include <algorithm>
#include <limits>
#include <chrono>
#include <cmath>
#include <map>
#include <numeric>
#include <optional>
#include "bm/plan/tolerances.h"
#include "blocker_index.h"

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

/// The same question, asked of a set whose present pieces are joined to each other and to
/// nothing else present. Then what is left is joined exactly when the pieces the unit touches
/// are joined to each other without it: any way between two pieces that went through the unit
/// can go round it instead, from where it went in to where it came out. So the search starts
/// from those pieces at once, a step from each in turn, and searches that meet go on as one
/// until all have met; one that runs out of pieces to reach first has found pieces held to the
/// rest only through the unit. That costs what the smaller side of a cut costs, not the whole set.
class Joined {
 public:
  Joined(const Context& ctx, size_t n) : ctx_(ctx), mark_(n, 0), from_(n, 0) {}

  /// Whether the present pieces of the set stay joined without `unit` (all of whose pieces are
  /// present), `leftAfter` of them being left; nothing if it cannot tell (the unit touches
  /// nothing present).
  std::optional<bool> without(const World::Present& present, const Unit& unit, size_t leftAfter) {
    if (leftAfter <= 1) return true;
    if (++stamp_ == 0) {
      std::fill(mark_.begin(), mark_.end(), 0);
      stamp_ = 1;
    }
    for (uint32_t p : unit.pieces) mark_[p] = stamp_, from_[p] = kUnit;
    parent_.clear();
    size_t searches = 0;
    for (uint32_t p : unit.pieces)
      for (uint32_t ci : ctx_.connectionsOf[p]) {
        const uint32_t q = other(ci, p);
        if (!present[q] || mark_[q] == stamp_) continue;
        mark_[q] = stamp_, from_[q] = static_cast<uint32_t>(searches);
        if (fronts_.size() <= searches) fronts_.emplace_back();
        fronts_[searches].assign(1, q);
        parent_.push_back(static_cast<uint32_t>(searches));
        searches++;
      }
    if (searches == 0) return std::nullopt;
    size_t apart = searches;
    while (apart > 1) {
      for (uint32_t s = 0; s < searches && apart > 1; s++) {
        if (parent_[s] != s) continue;  // gone on as part of another
        std::vector<uint32_t>& front = fronts_[s];
        if (front.empty()) return false;  // all it can reach is held to the rest only through the unit
        const uint32_t p = front.back();
        front.pop_back();
        for (uint32_t ci : ctx_.connectionsOf[p]) {
          const uint32_t q = other(ci, p);
          if (!present[q]) continue;
          if (mark_[q] != stamp_) {
            mark_[q] = stamp_, from_[q] = s;
            front.push_back(q);
            continue;
          }
          if (from_[q] == kUnit) continue;
          const uint32_t t = root(from_[q]);
          if (t == s) continue;
          parent_[t] = s;  // they meet: one search from here on
          front.insert(front.end(), fronts_[t].begin(), fronts_[t].end());
          fronts_[t].clear();
          apart--;
        }
      }
    }
    return true;
  }

 private:
  static constexpr uint32_t kUnit = UINT32_MAX;
  uint32_t other(uint32_t ci, uint32_t p) const {
    const Connection& c = ctx_.graph.connections[ci];
    return c.a == p ? c.b : c.a;
  }
  uint32_t root(uint32_t s) {
    while (parent_[s] != s) s = parent_[s] = parent_[parent_[s]];
    return s;
  }
  const Context& ctx_;
  std::vector<uint32_t> mark_, from_;  // per piece: the search that reached it (when mark_ is stamp_)
  uint32_t stamp_ = 0;
  std::vector<uint32_t> parent_;  // per search: the one it went on as
  std::vector<std::vector<uint32_t>> fronts_;
};

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
    BlockerIndex blockerIndex(n);
    std::vector<uint8_t> dirty(n, 0), seen(n, 0), reason(n, 0);  // dirty: 1 its mates changed, 2 it must be tried again
    std::vector<uint32_t> stack, todo;
    for (uint32_t p : set) dirty[p] = 2;
    // Whether the set's pieces are joined to each other and to nothing else present. Every piece
    // taken out leaves them so (only what stays joined is taken), and then Joined can tell.
    std::vector<uint8_t> inSet(n, 0);
    for (uint32_t p : set) inSet[p] = 1;
    bool joinedAlone = !set.empty();
    for (uint32_t p : set)
      for (uint32_t ci : ctx.connectionsOf[p]) {
        const Connection& c = ctx.graph.connections[ci];
        const uint32_t other = c.a == p ? c.b : c.a;
        if (present[other] && !inSet[other]) joinedAlone = false;
      }
    if (joinedAlone) {
      std::fill(seen.begin(), seen.end(), 0);
      stack.assign(1, set.front());
      seen[set.front()] = 1;
      size_t reached = 0;
      while (!stack.empty()) {
        const uint32_t p = stack.back();
        stack.pop_back();
        reached++;
        for (uint32_t ci : ctx.connectionsOf[p]) {
          const Connection& c = ctx.graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (seen[other] || !inSet[other]) continue;
          seen[other] = 1;
          stack.push_back(other);
        }
      }
      joinedAlone = reached == set.size();
    }
    Joined cuts(ctx, n);
    auto joined = [&](const Unit& u) {
      if (joinedAlone && std::all_of(u.pieces.begin(), u.pieces.end(), [&](uint32_t q) { return inSet[q] != 0; }))
        if (const std::optional<bool> known = cuts.without(present, u, left - u.pieces.size())) return *known;
      return staysJoined(ctx, set, present, u, stack, seen);
    };
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
    // An attempt that failed fails again for as long as everything that stopped it and every
    // mate it had are still there: pieces only ever leave. Such attempts are kept, with when
    // they were made, and not made again until one of those has gone.
    struct Tried {
      Extraction found;
      uint32_t when = 0;  // 0: never tried
    };
    std::vector<uint32_t> removedAt(n, 0);  // the round a piece left in
    uint32_t round = 1;
    std::vector<Tried> turnedBefore(n);
    std::map<std::vector<uint32_t>, Tried> togetherBefore;
    // A unit grown from a piece is the same again for as long as every piece whose presence the
    // growing looked at is as it was.
    struct Grown {
      Unit unit;
      uint32_t when = 0;          // 0: never grown
      std::vector<uint32_t> read;  // the pieces it looked at
    };
    std::vector<Grown> grownBefore(n);
    auto stillHolds = [&](const Unit& u, const Tried& t) {
      if (t.when == 0) return false;
      if (t.found.ok) return true;  // what could leave still can
      for (uint32_t stop : t.found.stoppedBy)
        if (removedAt[stop] >= t.when) return false;
      for (uint32_t p : u.pieces)
        for (uint32_t ci : ctx.connectionsOf[p]) {
          const Connection& c = ctx.graph.connections[ci];
          if (removedAt[c.a == p ? c.b : c.a] >= t.when) return false;
        }
      return true;
    };
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
        removedAt[p] = round;
        left--;
        for (uint32_t ci : ctx.connectionsOf[p]) {
          const Connection& c = ctx.graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (present[other] && !dirty[other]) dirty[other] = 1;  // its mates have changed: perhaps its directions too
        }
      }
      for (uint32_t removedPiece : m.unit.pieces)
        blockerIndex.blockerRemoved(removedPiece, [&](uint32_t q) {
          if (present[q] && !single[q].ok)
            dirty[q] = 2;  // a known obstacle was removed: retry its extraction
        });
      round++;
      last = &ctx.model.pieces()[m.unit.pieces.front()];
      removed.push_back(std::move(m));
    };
    // The reverse of how it should be built. Within a step: what leaves upward first (it goes in
    // from above), then continuing the run of its submodel, then top first, outside first.
    auto ranked = [&](uint32_t a, uint32_t b) {
      const Piece &pa = ctx.model.pieces()[a], &pb = ctx.model.pieces()[b];
      const bool ua = single[a].ok && dot(single[a].direction, -ctx.down) > 0.5, ub = single[b].ok && dot(single[b].direction, -ctx.down) > 0.5;
      if (ua != ub) return ua;
      if (last) {
        const bool ra = pa.path == last->path, rb = pb.path == last->path;
        if (ra != rb) return ra;
      }
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
    // Across steps (only when the latest step has nothing that can leave): later steps first.
    auto before = [&](uint32_t a, uint32_t b) {
      const int sa = ctx.model.pieces()[a].step, sb = ctx.model.pieces()[b].step;
      if (sa != sb) return sa > sb;
      return ranked(a, b);
    };
    // Pieces that go in together, tried as one; false if they cannot leave now.
    auto together = [&](const Unit& u, UnitSource source) {
      const auto known = togetherBefore.find(u.pieces);
      if (known != togetherBefore.end() && !known->second.found.ok && stillHolds(u, known->second)) return false;
      if (!free(u) || !joined(u)) return false;
      Tried& tried = togetherBefore[u.pieces];
      if (!stillHolds(u, tried)) {
        tried = {extract(ctx, u, &present, bounds), round};
        extractions++;
      }
      const Extraction e = tried.found;
      if (!e.ok) return false;
      take(u, source, e, Flag::None);
      return true;
    };
    auto whole = [&](const Unit& u) { return u.pieces.size() < left && std::all_of(u.pieces.begin(), u.pieces.end(), [&](uint32_t q) { return present[q] != 0; }); };
    // The unit grown from `p`, kept while nothing it looked at has changed.
    auto grownFrom = [&](uint32_t p) -> const Unit& {
      Grown& grown = grownBefore[p];
      if (grown.when == 0 || std::any_of(grown.read.begin(), grown.read.end(), [&](uint32_t q) { return removedAt[q] >= grown.when; })) {
        grown.read.clear();
        grown.unit = growUnit(ctx, p, &present, &grown.read);
        std::sort(grown.read.begin(), grown.read.end());
        grown.read.erase(std::unique(grown.read.begin(), grown.read.end()), grown.read.end());
        grown.when = round;
      }
      return grown.unit;
    };
    // The one-turn ways out of `pieces` that need one, tried again only when something changed.
    auto turnAll = [&](const std::vector<uint32_t>& pieces) {
      std::vector<uint32_t> again;
      for (uint32_t p : pieces)
        if (single[p].why == Flag::NoExit && !stillHolds(unitOf({p}), turnedBefore[p])) again.push_back(p);
      pool.parallelFor(again.size(), [&](size_t i) { turnedBefore[again[i]] = {extract(ctx, unitOf({again[i]}), &present, bounds, authoredAxis(again[i]), true), round}; });
      extractions += again.size();
    };
    auto takeTurned = [&](const std::vector<uint32_t>& pieces) {
      for (uint32_t p : pieces) {
        if (single[p].why != Flag::NoExit) continue;
        const Unit u = unitOf({p});
        const Extraction& turned = turnedBefore[p].found;
        if (!turned.ok || !free(u) || !joined(u)) continue;
        const Extraction way = turned;  // take() ends the round; the kept attempt is not touched by it
        take(u, UnitSource::Piece, way, Flag::None);
        return true;
      }
      return false;
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
        if (present[p] && dirty[p]) todo.push_back(p), reason[p] = dirty[p], dirty[p] = 0;
      std::vector<uint8_t> skipped(todo.size(), 0);
      pool.parallelFor(todo.size(), [&](size_t i) {
        const uint32_t p = todo[i];
        // Only its mates changed. If the directions they allow are the same as before, every
        // attempt would meet the same pieces as before, which are all still there.
        if (reason[p] == 1 && single[p].ok) {  // what could leave still can: only things in its way have gone
          skipped[i] = 1;
          return;
        }
        if (reason[p] == 1 && !single[p].ok && !single[p].tried.empty() && length(authoredAxis(p)) == 0) {
          const std::vector<Leave> now = leaveDirections(ctx, unitOf({p}), &present);
          bool same = now.size() == single[p].tried.size();
          for (size_t k = 0; same && k < now.size(); k++) same = dot(now[k].direction, single[p].tried[k]) >= kReleaseAgree;
          if (same) {
            skipped[i] = 1;
            return;
          }
        }
        single[p] = extract(ctx, unitOf({p}), &present, bounds, authoredAxis(p), false);
      });
      for (size_t i = 0; i < todo.size(); i++) {
        if (skipped[i]) continue;
        extractions++;
        const uint32_t p = todo[i];
        blockerIndex.updated(p, single[p].stoppedBy, single[p].ok);
      }
      // The file's steps lead: the latest step that still has pieces is taken apart first, its
      // submodels as one, then its pieces, then those of its pieces that only leave together.
      int frontier = std::numeric_limits<int>::min();
      for (uint32_t p : set)
        if (present[p]) frontier = std::max(frontier, ctx.model.pieces()[p].step);
      std::vector<uint32_t> latest;
      for (uint32_t p : set)
        if (present[p] && ctx.model.pieces()[p].step == frontier) latest.push_back(p);
      std::sort(latest.begin(), latest.end(), ranked);
      auto ofLatest = [&](const Unit& u) { return std::all_of(u.pieces.begin(), u.pieces.end(), [&](uint32_t q) { return ctx.model.pieces()[q].step >= frontier; }); };
      bool took = false;
      if (depth < 4)
        for (uint32_t p : latest) {  // a submodel placed in this step, the outermost use first
          for (size_t k = units.authoredOf[p].size(); k-- > 0 && !took;) {
            const Unit& u = units.authored[units.authoredOf[p][k]];
            if (whole(u) && ofLatest(u)) took = together(u, UnitSource::Authored);
          }
          if (took || outOfTime()) break;
        }
      if (took) continue;
      for (uint32_t p : latest) {
        if (!single[p].ok) continue;
        const Unit u = unitOf({p});
        if (!free(u) || !joined(u)) continue;
        take(u, UnitSource::Piece, single[p], Flag::None);
        took = true;
        break;
      }
      if (took) continue;
      turnAll(latest);
      if (takeTurned(latest)) continue;
      if (depth < 4) {  // the step's own pieces joined to each other, as one
        std::vector<uint8_t> inStep(present.size(), 0), done(present.size(), 0);
        for (uint32_t p : latest) inStep[p] = 1;
        for (uint32_t p : latest) {
          if (took || outOfTime()) break;
          if (done[p] || single[p].ok) continue;
          Unit u;
          std::vector<uint32_t> todoStep{p};
          done[p] = 1;
          while (!todoStep.empty()) {
            const uint32_t q = todoStep.back();
            todoStep.pop_back();
            u.pieces.push_back(q);
            for (uint32_t ci : ctx.connectionsOf[q]) {
              const Connection& c = ctx.graph.connections[ci];
              const uint32_t other = c.a == q ? c.b : c.a;
              if (inStep[other] && !done[other]) done[other] = 1, todoStep.push_back(other);
            }
          }
          std::sort(u.pieces.begin(), u.pieces.end());
          if (u.pieces.size() > 1 && u.pieces.size() < left) took = together(u, UnitSource::Grown);
        }
      }
      if (took) continue;
      if (depth < 4)
        for (uint32_t p : latest) {
          if (took || outOfTime()) break;
          if (single[p].ok) continue;
          for (uint32_t gi : units.bodyOf[p])
            if (!took && whole(units.bodies[gi]) && ofLatest(units.bodies[gi])) took = together(units.bodies[gi], UnitSource::Body);
          if (took) break;
          const Unit& grown = grownFrom(p);
          if (grown.pieces.size() > 1 && grown.pieces.size() < left && ofLatest(grown)) took = together(grown, UnitSource::Grown);
        }
      if (took) continue;
      // Nothing of the latest step can leave alone or with its own step. Borrow as little as helps:
      // first a unit grown from one of its pieces into earlier steps (what it is attached to)...
      if (depth < 4)
        for (uint32_t p : latest) {
          if (took || outOfTime()) break;
          if (single[p].ok) continue;
          const Unit& grown = grownFrom(p);
          if (grown.pieces.size() > 1 && grown.pieces.size() < left) took = together(grown, UnitSource::Grown);
        }
      if (took) continue;
      // ...then an earlier step's piece that is in the way of one of its pieces...
      {
        std::vector<uint8_t> inWay(present.size(), 0);
        for (uint32_t p : latest)
          for (uint32_t q : single[p].stoppedBy)
            if (q < present.size() && present[q] && ctx.model.pieces()[q].step < frontier) inWay[q] = 1;
        std::vector<uint32_t> blockers;
        for (uint32_t q : set)
          if (inWay[q] && single[q].ok) blockers.push_back(q);
        std::sort(blockers.begin(), blockers.end(), before);
        for (uint32_t q : blockers) {
          const Unit u = unitOf({q});
          if (!free(u) || !joined(u)) continue;
          take(u, UnitSource::Piece, single[q], Flag::None);
          took = true;
          break;
        }
      }
      if (took) continue;
      // ...and only then any earlier step's piece (each built after the step: an inversion, which
      // certifyPlay counts), later steps first.
      std::vector<uint32_t> ready;
      for (uint32_t p : set)
        if (present[p] && single[p].ok) ready.push_back(p);
      std::sort(ready.begin(), ready.end(), before);
      for (uint32_t p : ready) {
        const Unit u = unitOf({p});
        if (!free(u) || !joined(u)) continue;
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
      turnAll(stuck);
      if (takeTurned(stuck)) continue;
      // Nothing leaves alone: pieces that must go in together.
      for (uint32_t p : stuck) {
        if (took || outOfTime()) break;
        std::vector<std::pair<Unit, UnitSource>> tries;
        if (depth < 4) {
          for (uint32_t gi : units.authoredOf[p])
            if (whole(units.authored[gi])) tries.emplace_back(units.authored[gi], UnitSource::Authored);
          for (uint32_t gi : units.bodyOf[p])
            if (whole(units.bodies[gi])) tries.emplace_back(units.bodies[gi], UnitSource::Body);
          const Unit& grown = grownFrom(p);
          if (grown.pieces.size() > 1 && grown.pieces.size() < left) tries.emplace_back(grown, UnitSource::Grown);
        }
        for (auto& [u, source] : tries)
          if (together(u, source)) {
            took = true;
            break;
          }
      }
      if (took) continue;
      // Still nothing: the engine cannot show how this piece goes in, and says so on it.
      for (uint32_t p : stuck) {
        const Unit u = unitOf({p});
        if (!joined(u)) continue;
        take(u, UnitSource::Piece, single[p], single[p].why == Flag::None ? Flag::Blocked : single[p].why);
        took = true;
        break;
      }
      if (!took) {  // cannot happen for a joined set: some piece is always not a cut piece
        const uint32_t p = stuck.front();
        take(unitOf({p}), UnitSource::Piece, single[p], Flag::Blocked);
        joinedAlone = false;  // what is left may not be joined now
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
  // Every use of a submodel: the pieces whose ids start with that use's item ("<item>/" per
  // level). Not the submodel's name: two uses of one submodel are two things, in two places.
  std::map<std::string, std::vector<uint32_t>> byUse;
  for (uint32_t i = 0; i < n; i++) {
    const std::string& id = pieces[i].id;
    size_t from = 0;
    for (size_t depth = 0; depth < pieces[i].path.size(); depth++) {
      const size_t slash = id.find('/', from);
      if (slash == std::string::npos) break;
      byUse[id.substr(0, slash)].push_back(i);
      from = slash + 1;
    }
  }
  // A use goes in as one only where its pieces hold each other: each set of them joined through
  // the use's own pieces is a unit of its own. Pieces of a use that are not joined to each other
  // (a loose part left in a submodel, things fixed to the model each on its own) have nothing to
  // be carried in on together, and a unit made of them would put some of them in floating.
  std::vector<std::vector<uint32_t>> joinedTo(n);
  for (const connect::Connection& c : graph.connections)
    if (c.a < n && c.b < n) joinedTo[c.a].push_back(c.b), joinedTo[c.b].push_back(c.a);
  std::vector<uint32_t> inUse(n, 0), seen(n, 0);  // per piece: the last use it was in, and looked at in
  uint32_t use = 0;
  std::vector<Unit> authored;
  for (auto& [name, list] : byUse) {
    if (list.size() < 2 || list.size() >= n) continue;
    use++;
    for (uint32_t p : list) inUse[p] = use;
    for (uint32_t start : list) {
      if (seen[start] == use) continue;
      seen[start] = use;
      std::vector<uint32_t> set{start}, todo{start};
      while (!todo.empty()) {
        const uint32_t p = todo.back();
        todo.pop_back();
        for (uint32_t q : joinedTo[p])
          if (inUse[q] == use && seen[q] != use) seen[q] = use, set.push_back(q), todo.push_back(q);
      }
      if (set.size() < 2) continue;
      std::sort(set.begin(), set.end());
      authored.push_back({std::move(set)});
    }
  }
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

Unit growUnit(const Context& ctx, uint32_t piece, const World::Present* present, std::vector<uint32_t>* read) {
  auto there = [&](uint32_t p) {
    if (read) read->push_back(p);
    return !present || (p < present->size() && (*present)[p]);
  };
  Unit unit{{piece}};
  // What leaveDirections looks at: the unit's pieces and what they are joined to.
  auto noting = [&](Unit u) {
    if (read)
      for (uint32_t p : u.pieces) {
        read->push_back(p);
        for (uint32_t ci : ctx.connectionsOf[p]) read->push_back(ctx.graph.connections[ci].a == p ? ctx.graph.connections[ci].b : ctx.graph.connections[ci].a);
      }
    return u;
  };
  while (static_cast<int>(unit.pieces.size()) < kMaxGroup) {
    if (unit.pieces.size() > 1 && !leaveDirections(ctx, unit, present).empty()) return noting(unit);
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
  const bool leaves = unit.pieces.size() > 1 && !leaveDirections(ctx, unit, present).empty();
  noting(unit);
  return leaves ? unit : Unit{};
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
