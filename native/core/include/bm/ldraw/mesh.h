#pragma once
// A part flattened out of its subfiles into one triangle mesh.
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "bm/ldraw/library.h"
#include "bm/math.h"

namespace bm::ldraw {

struct Mesh {
  std::vector<float> positions;     ///< xyz per vertex, part space, LDU; welded at 1e-4
  std::vector<uint32_t> triangles;  ///< 3 indices each, counter-clockwise seen from outside
  std::vector<int32_t> triColor;    ///< per triangle; 16 = the piece's own colour
  std::vector<float> edges;         ///< xyz pairs: the part's outline lines
  Box bounds;                       ///< of triangles and edges; empty when there is no geometry
  Box body;                         ///< bounds without the studs on top; what grid placement measures
  std::vector<std::string> missing; ///< subfiles that were not found, or closed a reference loop
  /// Every file the part is made of with its Library::stamp (0 = missing), sorted by name.
  std::vector<std::pair<std::string, uint64_t>> deps;
  uint64_t sourceHash = 0;          ///< over `deps`: changes when any of those files changes
};

struct FlattenOptions {
  bool hiResPrimitives = false;  ///< use p/48 curved primitives where they exist
  bool logoStuds = false;        ///< studs with the logo (stud-logo4.dat)
  /// Use the library's low-resolution files (p/8: 8-sided curves and studs) wherever one of
  /// the same name exists. For pieces drawn small. Wins over hiResPrimitives.
  bool lowResPrimitives = false;
};

/// Hash of a dependency list, as stored in Mesh::sourceHash.
uint64_t hashDeps(const std::vector<std::pair<std::string, uint64_t>>& deps);

/// Flattens `partName` (".dat" may be left off). Never throws on bad data: what is missing
/// is listed in Mesh::missing and the rest is returned.
///
/// Winding follows the LDraw BFC rules, so certified geometry faces outward whatever
/// mirroring its references apply; geometry that is not certified (or is in a NOCLIP
/// section) is emitted in both windings.
Mesh flatten(std::string_view partName, const Library& library, const FlattenOptions& options = {});

}  // namespace bm::ldraw
