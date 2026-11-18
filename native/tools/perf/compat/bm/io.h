#pragma once
// Minimal declarations for the portable (no JSON dependency) collision verifier.
// This header intentionally shadows the production bm/io.h ONLY when
// tools/perf/compat precedes core/include in the verifier's include path.
// The native application and CMake tests always include the real bm/io.h.
#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>
#include "bm/model.h"

namespace bm::io {
class Error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};
struct StudioArchive {
  std::string model;
  std::vector<ldraw::File> customParts;
  size_t availableCustomParts = 0;
};
StudioArchive readStudioArchive(std::string_view);
std::string readStudioIo(std::string_view);
Model modelFromLDraw(std::string_view, const std::string&, const ldraw::Library&,
                     std::vector<ldraw::File>, size_t);
std::string toLDraw(const Model&);
}  // namespace bm::io
