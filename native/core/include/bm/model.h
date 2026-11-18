#pragma once
// A loaded model: every placed part, flattened out of its submodels.
#include <string>
#include <vector>
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/math.h"

namespace bm {

/// One placed part.
struct Piece {
  std::string id;                 ///< stable within the model: "<submodel item>/.../<item>"
  std::string part;               ///< normalised file name, e.g. "3001.dat"
  int color = 16;                 ///< LDraw colour code
  Xform world;                    ///< placement in the model, LDU
  int step = 0;                   ///< build step in the root model, from 0
  std::vector<std::string> path;  ///< the submodels it sits in, outermost first
};

/// What loading could not make sense of. A model with a non-empty report still loads.
struct LoadReport {
  std::vector<std::string> missing;        ///< parts and submodels that were not found
  std::vector<std::string> cycles;         ///< submodel loops, as "a > b > a"; the closing use is dropped
  std::vector<std::string> unknownColors;  ///< colour names that are not in the colour table
  int skippedLines = 0;                    ///< malformed LDraw lines
  size_t studioCustomPartsAvailable = 0;    ///< .dat entries inside a Studio .io archive
  size_t studioCustomPartsLoaded = 0;       ///< reachable .dat files loaded from that archive
  size_t studioCustomPartSkippedLines = 0;  ///< malformed lines in loaded embedded custom parts
};

/// The box a missing part is given, so a model with unknown parts still has a size.
inline constexpr Box kPlaceholderBox{{0, 0, 0}, {20, 24, 20}};

class Model {
 public:
  struct Data {
    std::vector<Piece> pieces;
    std::vector<std::string> submodels;
    LoadReport report;
    ldraw::Library library;                ///< the part library plus this model's own files
    std::vector<ldraw::File> inlineParts;  ///< part files that came inside the model file
  };
  explicit Model(Data data);

  const std::vector<Piece>& pieces() const { return data_.pieces; }
  /// The submodels used, in the order they are first used.
  const std::vector<std::string>& submodels() const { return data_.submodels; }
  /// Number of build steps: one more than the highest piece step; 0 for an empty model.
  int stepCount() const { return stepCount_; }
  const LoadReport& report() const { return data_.report; }
  const ldraw::Library& library() const { return data_.library; }
  const std::vector<ldraw::File>& inlineParts() const { return data_.inlineParts; }

  /// The mesh of a piece's part: from `cache` for library parts, flattened here for the
  /// model's own inline parts. Never null; a missing part has an empty mesh.
  std::shared_ptr<const ldraw::Mesh> mesh(const std::string& part, ldraw::PartCache& cache) const;

  /// Bounds of all pieces. Missing parts count as a placeholder box. Empty for no pieces.
  Box bounds(ldraw::PartCache& cache) const;

 private:
  struct InlineMeshCache;
  Data data_;
  std::shared_ptr<InlineMeshCache> inlineMeshes_;
  int stepCount_ = 0;
};

}  // namespace bm
