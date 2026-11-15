#pragma once
// Reading and writing model files: LDraw/MPD, BrickMotion plan and project JSON, Studio .io.
#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>
#include <nlohmann/json.hpp>
#include "bm/model.h"

namespace bm::io {

/// A file could not be read or is not what it claims to be. what() is fit to show a person.
class Error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

enum class Format { LDraw, Plan, Project, StudioIo };

/// Tells the format from the first bytes of the file (64 or more), not from its name.
Format sniff(const std::filesystem::path& path, std::string_view head);

/// Loads a model in any format. Throws Error if the file cannot be read or is damaged.
/// Missing parts, loops and malformed lines do not throw: see Model::report().
/// Plan files need part sizes; pass the cache to use, or leave it null to use the default.
Model load(const std::filesystem::path& path, const ldraw::Library& library, ldraw::PartCache* cache = nullptr);

/// The model as LDraw text, flattened: one line per piece with its final placement,
/// `0 STEP` between steps, and the model's own inline part files after it.
std::string toLDraw(const Model& model);

/// A plan file, kept verbatim (key order included) so fields this version does not know
/// survive a read and write.
struct PlanDoc {
  nlohmann::ordered_json json;
};
/// Parses and checks the structure the engine relies on. Throws Error with every problem
/// found, one per line.
PlanDoc readPlan(std::string_view text);
std::string writePlan(const PlanDoc& doc);
/// Places the plan's items. Grid placements follow the app's rule: x and z in studs, y in
/// plates, the minimum corner of the turned footprint, bottom of the piece.
Model fromPlan(const PlanDoc& doc, const ldraw::Library& library, ldraw::PartCache& cache);

/// The plan inside a project (.brickmotion) file. Throws Error if it is not a version-1 project.
PlanDoc readProject(std::string_view text);

/// The LDraw model inside a BrickLink Studio .io archive (a ZIP, sometimes protected with
/// Studio's public format password). Throws Error for anything else.
std::string readStudioIo(std::string_view bytes);

}  // namespace bm::io
