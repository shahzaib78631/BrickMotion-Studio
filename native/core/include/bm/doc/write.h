#pragma once
// Writing the document: .brickmotion projects the web app opens, and LDraw MPD.
#include <string>
#include <string_view>
#include <nlohmann/json.hpp>
#include "bm/doc/source.h"

namespace bm::doc {

/// A whole project file as read; its "plan" is replaced when it is written.
struct Project {
  nlohmann::ordered_json json;
};
/// Throws io::Error as io::readProject does.
Project readProjectFile(std::string_view text);

/// The project with `source` as its plan. `base` is {} for a new project. The web's "timelines"
/// are a cache of planned animation keyed to the plan's pieces (src/io/projectFile.ts plans again
/// when one is missing), so when `planChanged` the key is dropped and the web never plays stale
/// motion; "settings" and every other key are kept. "savedAt" is the time of writing, ISO 8601 UTC.
std::string writeProject(const Project& base, const Source& source, bool planChanged);

/// LDraw MPD: a `0 FILE` per def (root first), `0 STEP` between steps, inline parts last.
/// Colours are codes; grid placements are written where they put the piece.
std::string writeMpd(const Source& source, const ldraw::Library& library);

}  // namespace bm::doc
