#pragma once
// Opt-in collision-geometry completeness check. This is deliberately separate from
// Model::bounds()/load(): auditing every mesh and building every collision shape can
// be expensive, and ordinary model loads must remain fast.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "bm/collide/shape.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bm::collide {

struct GeometryIssue {
  std::string part;                  ///< normalized LDraw name
  size_t instances = 0;             ///< number of pieces using this part
  size_t triangles = 0;             ///< triangles in the flattened mesh
  bool modelScoped = false;         ///< comes from MPD or a Studio CustomParts archive
  bool noCollisionShape = false;    ///< no usable triangles after collision-shape construction
  std::vector<std::string> missing; ///< missing/cyclic transitive mesh dependencies
};

struct GeometryAudit {
  size_t distinctParts = 0;
  size_t modelScopedParts = 0;
  size_t partsWithoutCollisionShapes = 0;
  size_t partsWithMissingDependencies = 0;
  size_t malformedEmbeddedLines = 0; ///< silently skipped custom-part LDraw commands
  uint64_t instantiatedTriangles = 0;
  // Only problematic part types, sorted by part name so results are reproducible.
  std::vector<GeometryIssue> issues;

  /// The model has a collision shape for every placed part and no unresolved
  /// transitive mesh dependencies. This is a necessary, NOT sufficient, condition
  /// for collision accuracy (the engine still has sampled rotation sweeps, etc.).
  bool structurallyComplete() const {
    return partsWithoutCollisionShapes == 0 && partsWithMissingDependencies == 0 && malformedEmbeddedLines == 0;
  }
};

/// Audit each distinct placed part once, reusing Model's model-scoped mesh cache
/// and the supplied global shape cache. Does not modify the model or any collider
/// tolerances. Call explicitly before asserting that an imported model is ready
/// for collision-based planning.
GeometryAudit auditGeometry(const Model& model, ldraw::PartCache& parts, ShapeCache& shapes);

}  // namespace bm::collide
