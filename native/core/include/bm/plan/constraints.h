#pragma once
// What the author fixed in a plan file, as constraints the planner works within.
#include "bm/io.h"
#include "bm/plan/plan.h"

namespace bm::plan {

/// Reads the author's constraints from the top-level steps of a plan document (the fields are
/// those of `AssemblyHints` and `Step` in src/plan/types.ts): a step with `pinOrder` keeps its
/// pieces in the order listed; `assembly.after` and `assembly.attachTo` put a piece after others;
/// `assembly.insertionAxis` is the way out of its seat; `assembly.flight` is its own flight, poses
/// `[x, y, z, qx, qy, qz, qw]` from start to seat in the seat's own frame. Items are matched to
/// Model::pieces() by id; what cannot be matched or read is left out. Pieces inside submodels
/// are not read yet.
Constraints readConstraints(const io::PlanDoc& doc, const Model& model);

}  // namespace bm::plan
