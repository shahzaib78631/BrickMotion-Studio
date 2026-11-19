#pragma once
// Plain types Swift sees. No engine header, template of ours or std::function may appear in a
// bmapp header: Swift's C++ interop reads these directly.
#include <cstdint>
#include <string>
#include <vector>

namespace bmapp {

struct Vec2 {
  double x = 0, y = 0;
};
struct Vec3 {
  double x = 0, y = 0, z = 0;
};
/// Row-major 3x3.
struct Mat3 {
  double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
};

enum class ViewPreset { Front, Back, Right, Left, Top, Bottom };
enum class PlanState { Idle, Planning, Ready, Failed };
enum class SelectMode { Replace, Add, Toggle };
enum class Arrow { Left, Right, Up, Down };

/// The undoable edits.
enum class Edit { Move, Rotate, Recolor, Delete, Duplicate, Paste, ReplacePart, MakeUnique };

using PieceList = std::vector<uint32_t>;
using StringList = std::vector<std::string>;

/// What opening a file gave.
struct OpenResult {
  bool ok = false;
  std::string error;     ///< why it could not open, fit to show a person; empty when ok
  std::string warnings;  ///< missing parts, loops, unknown colours: one per line
};

/// Some pieces, described.
struct Summary {
  size_t count = 0;                ///< distinct known pieces
  std::vector<std::string> parts;  ///< their distinct part files, sorted
};

/// What a command changed. When `structure` is false only placements and colours changed and the
/// piece count is the same: `moved` and `recolored` then list every affected piece (all uses).
struct Changed {
  bool structure = false;
  std::vector<uint32_t> moved;
  std::vector<uint32_t> recolored;
  uint64_t version = 0;  ///< the session's version after it
};

}  // namespace bmapp
