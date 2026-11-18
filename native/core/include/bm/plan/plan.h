#pragma once
// The build plan: an order and a flight for every piece, found by taking the model apart.
#include <cstdint>
#include <string>
#include <vector>
#include "bm/collide/world.h"
#include "bm/connect/graph.h"
#include "bm/jobs.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::plan {

/// Pieces that move as one rigid thing. Sorted piece indices.
struct Unit {
  std::vector<uint32_t> pieces;
};

/// Where a multi-piece unit comes from.
enum class UnitSource : uint8_t { Piece, Authored, Body, Grown };

enum class Flag : uint8_t {
  None,              ///< found by the planner; whether it is certified is the certifier's word
  Unjoined,          ///< the piece is joined to nothing in the file
  NoDirection,       ///< no direction satisfies all its connections, alone or in any group tried
  Blocked,           ///< every allowed direction is blocked by a piece built before it
  NoExit,            ///< it leaves its seat but no path of straight legs reaches open air
  AuthoredCrossing,  ///< the author's own flight passes through a piece
  Budget,            ///< planning was cancelled or ran out of time before this move was settled
};
const char* name(Flag flag);
const char* name(UnitSource source);

/// One unit, tried along the directions its connectors allow.
struct Extraction {
  bool ok = false;
  Vec3 direction;                 ///< unit, model space: the way it leaves its seat
  double seatTravel = 0;          ///< LDU along `direction` while its mates are engaged
  std::vector<Xform> path;        ///< the unit's motion from its seat: identity first, open air last; straight legs between
  uint32_t blocker = UINT32_MAX;  ///< when !ok: a piece in the way of the attempt that got furthest
  Flag why = Flag::None;          ///< when !ok: NoDirection, Blocked or NoExit
  std::vector<uint32_t> stoppedBy;  ///< when !ok: every piece that stopped one of the attempts, ascending
  std::vector<Vec3> tried;          ///< when !ok: the directions its connectors allowed
};

struct Move {
  Unit unit;                      ///< what goes in
  UnitSource source = UnitSource::Piece;
  Vec3 insertion;                 ///< unit, model space: the way it travels into its seat
  double seatTravel = 0;
  std::vector<Xform> path;        ///< motion from the seat: identity first, open air last (the flight is this reversed)
  Flag flag = Flag::None;
  uint32_t blocker = UINT32_MAX;
  int sub = -1;                   ///< index into Plan::subs: how a multi-piece unit is itself built
  bool authoredAxis = false, authoredFlight = false;  ///< the author set it; the planner did not choose it
};

struct Plan {
  std::vector<Move> moves;         ///< in build order
  std::vector<Plan> subs;
  std::vector<std::string> notes;  ///< things the author should know that belong to no one move
  double planMs = 0;
  bool complete = true;            ///< false when cancelled or out of time
  size_t extractions = 0;          ///< units tried, for measuring
};

/// What the author fixed. All indexed by piece; any may be empty.
struct Constraints {
  /// Pieces that must be built in exactly this order, one list per pinned step.
  std::vector<std::vector<uint32_t>> pinned;
  /// `second` is built after `first`.
  std::vector<std::pair<uint32_t, uint32_t>> after;
  /// The insertion axis the author set, pointing out of the seat; zero when unset.
  std::vector<Vec3> insertionAxis;
  /// The author's own flight as motions from the seat, start first, seat (identity) last; empty when unset.
  std::vector<std::vector<Xform>> flight;
};

struct Options {
  const CancelToken* cancel = nullptr;
  JobPool* pool = nullptr;     ///< null: JobPool::shared()
  double budgetSeconds = 0;    ///< 0: none
  Vec3 down{0, 1, 0};          ///< LDraw's y points down
  const Constraints* authored = nullptr;
};

/// Read-only things every planner step needs, built once per model.
struct Context {
  const Model& model;
  const connect::Graph& graph;
  const collide::World& world;
  std::vector<std::vector<uint32_t>> connectionsOf;  ///< per piece: indices into Graph::connections
  Vec3 down{0, 1, 0};
  double floor = 0;  ///< the model's base: the furthest any piece reaches along `down`; nothing goes below it
  Context(const Model& model, const connect::Graph& graph, const collide::World& world, Vec3 down = {0, 1, 0});
};

/// The directions `unit` may leave along given what is present: those that satisfy every mate
/// it has with a present piece outside it. Empty when none does. A unit with no such mate may
/// leave any way; up is offered first.
struct Leave {
  Vec3 direction;
  double travel = 0;  ///< the longest engaged length among its mates
};
std::vector<Leave> leaveDirections(const Context& ctx, const Unit& unit, const collide::World::Present* present);

/// Tries to take `unit` out of the present pieces, along each direction its connectors allow:
/// out of its seat (its own mates' zones carried along as corridors, nothing else exempt), then
/// by straight legs to open air outside `bounds`. Thread-safe. `only`, if not zero, is the one
/// direction to try whatever the connectors say (the author's).
/// With `turns` false only a straight way out is looked for (out along the seat's own line, up, or
/// along a model axis); a way out with one turn in it costs many more sweeps and is asked for
/// only when nothing else can leave.
Extraction extract(const Context& ctx, const Unit& unit, const collide::World::Present* present, const Box& bounds, Vec3 only = {}, bool turns = true);

/// Groups the planner may move as one: each use of a submodel in the file (each set of its
/// pieces that are joined to each other, when they are not all), and rigid bodies.
struct Units {
  std::vector<Unit> authored, bodies;
  std::vector<std::vector<uint32_t>> authoredOf, bodyOf;  ///< per piece: the groups holding it, smallest first
};
Units findUnits(const Model& model, const connect::Graph& graph);

/// Grows a unit from `piece`, one present neighbour at a time, until its mates with the rest
/// agree on a direction. Empty when none up to kMaxGroup does. `read`, if given, receives every
/// piece whose presence the answer depends on (some more than once): while none of those
/// changes, the answer does not.
Unit growUnit(const Context& ctx, uint32_t piece, const collide::World::Present* present, std::vector<uint32_t>* read = nullptr);

/// Plans the whole model. Never throws for a model that loaded; what it cannot do is flagged.
Plan plan(const Model& model, const connect::Graph& graph, ldraw::PartCache& parts, collide::ShapeCache& shapes, const Options& options = {});

/// The step a piece is placed in at each level of the file: the root's first, then the step
/// within each submodel it sits in (read from Piece::id, "<step>:<item>/..."; {Piece::step} for
/// an id of another form).
std::vector<int> stepsOf(const Piece& piece);
/// Whether steps `a` come after steps `b` in the build, level by level. A submodel is built
/// before the rest of the step that places it: {5} is after {5, 3}.
bool laterSteps(const std::vector<int>& a, const std::vector<int>& b);

}  // namespace bm::plan
