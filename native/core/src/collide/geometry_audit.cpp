#include "bm/collide/geometry_audit.h"

#include <algorithm>
#include <map>
#include <utility>

namespace bm::collide {

GeometryAudit auditGeometry(const Model& model, ldraw::PartCache& parts, ShapeCache& shapes) {
  // A map gives deterministic results, independent of the order of the pieces
  // or hash-table iteration. The second field is the number of placements.
  std::map<std::string, size_t> placed;
  for (const Piece& piece : model.pieces()) ++placed[ldraw::normalizeName(piece.part)];

  GeometryAudit audit;
  audit.distinctParts = placed.size();
  audit.malformedEmbeddedLines = model.report().studioCustomPartSkippedLines;
  for (const auto& [name, count] : placed) {
    const bool scoped = model.library().isInline(name);
    if (scoped) ++audit.modelScopedParts;

    const auto mesh = model.mesh(name, parts);
    const auto shape = shapes.get(mesh);
    const bool missingShape = shape->nodes.empty();
    const bool missingDependencies = !mesh->missing.empty();
    const uint64_t triangles = static_cast<uint64_t>(mesh->triangles.size() / 3);
    audit.instantiatedTriangles += triangles * static_cast<uint64_t>(count);
    audit.partsWithoutCollisionShapes += missingShape ? 1u : 0u;
    audit.partsWithMissingDependencies += missingDependencies ? 1u : 0u;
    if (!missingShape && !missingDependencies) continue;

    GeometryIssue issue;
    issue.part = name;
    issue.instances = count;
    issue.triangles = static_cast<size_t>(triangles);
    issue.modelScoped = scoped;
    issue.noCollisionShape = missingShape;
    issue.missing = mesh->missing;
    std::sort(issue.missing.begin(), issue.missing.end());
    issue.missing.erase(std::unique(issue.missing.begin(), issue.missing.end()), issue.missing.end());
    audit.issues.push_back(std::move(issue));
  }
  return audit;
}

}  // namespace bm::collide
