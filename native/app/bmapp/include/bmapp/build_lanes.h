#pragma once
// The Build timeline's lanes, worked out from a planned BuildTimeline: step runs, step clips with
// their pauses, submodel clips, the arrival-drop target and the Parts lane's row packing.
// Both app shells (Swift and Rust) draw these; neither keeps its own copy of the maths.

#include <cstddef>
#include <cstdint>
#include <vector>

#include "bmapp/types.h"
#include "bmapp/viewport.h"

namespace bmapp {

class Session;

/// Consecutive flights of one step (or overlapping flights of neighbouring steps) merged.
struct LaneRun {
  size_t id = 0;
  int step = 0;
  double start = 0, end = 0;
  double next = 0;  ///< the following run's start (or the build's end), never before `end`
};

/// One step's flights and the pause after it, up to the next step's start (or the timeline's end).
struct LaneStep {
  int step = 0;
  double start = 0, end = 0, pauseEnd = 0;
  std::vector<size_t> flights;  ///< indexes into BuildTimeline::flights, in timeline order
};

/// A submodel's clip: one the planner scheduled (`scheduled`, `flight`) or, for a submodel used in a
/// step whose pieces the planner flew one by one, its use (`item`), spanning its pieces' flights.
struct LaneSubmodel {
  bool scheduled = false;
  int flight = -1;
  uint64_t item = 0;
  int depth = 0;
  double start = 0, end = 0;
  double attach = -1;  ///< < 0: none
  StringList path;
  PieceList pieces;
};

struct BuildLanes {
  uint64_t version = 0;
  std::vector<LaneRun> runs;
  std::vector<LaneStep> steps;  ///< sorted by start
  std::vector<LaneSubmodel> submodels;
  std::vector<size_t> diagnostics;  ///< flights whose flag is not empty
};

/// `session` (may be null) resolves submodel uses the planner flew piece by piece.
BuildLanes buildLanes(const BuildTimeline& timeline, const Session* session);

/// The run at `seconds`: the last one starting at or before it (the first before any). False with no runs.
bool runAt(const BuildLanes& lanes, double seconds, size_t* run);

/// Previous / next step travel: the next run start after `time + 0.02` (else `duration`), or the
/// last one before `time - 0.02` (else 0).
double travel(const BuildLanes& lanes, double time, double duration, bool forward);

/// The flight nearest `seconds` among those at (`depth`) or not at (`!depth`) a submodel depth; -1 none.
int64_t nearestFlight(const BuildTimeline& timeline, double seconds, bool depth);

/// Where a part dropped on the Parts lane at `time` goes: before the first flight of the run under
/// `time` that starts at or after it, else after the run's last. `time` is the x the marker is drawn at.
struct ArrivalTarget {
  bool ok = false;
  int step = 0;
  size_t before = 0;
  double time = 0;
};
ArrivalTarget arrivalTarget(const BuildLanes& lanes, const BuildTimeline& timeline, const Session* session,
                            double time, const PieceList& excluding);

/// Packs spans (sorted by x) into rows: each goes in the first row free at `x + 0.0001`, and keeps it
/// until `x + width + 1`.
struct LaneSpan {
  double x = 0, width = 0;
};
using LaneSpanList = std::vector<LaneSpan>;
struct LanePacking {
  std::vector<uint32_t> rows;
  uint32_t count = 0;
};
LanePacking packLane(const LaneSpanList& sorted);

}  // namespace bmapp
