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
enum class Edit {
  Move, Rotate, Recolor, Delete, Duplicate, Paste, ReplacePart, MakeUnique,
  AddStep, DeleteStep, MoveStep, SplitStep, MergeSteps, StepFields, MoveToStep, ReorderInStep,
  NewSubmodel, MakeSubmodel, Extract, MoveToModel, RenameSubmodel, DeleteSubmodel,
};

/// A step's editorial fields, as a person edits them.
struct StepFields {
  std::string title, notes;  ///< title at most 80 characters, notes 1000, both trimmed
  double pauseAfter = 0;     ///< seconds held after the step, 0–10, one decimal
  bool pinOrder = false;     ///< its pieces keep their order and stop waiting on what they rest on
};

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
  /// Not empty when the command was refused: nothing changed, no undo step was made, and this is
  /// why, fit to show a person.
  std::string refused;
};

/// A part file in the library, as Replace Part lists it.
struct PartMatch {
  std::string name, description;  ///< "3001.dat", "Brick  2 x  4"
};

/// One piece, described for the inspector.
struct PieceInfo {
  uint32_t piece = 0;
  std::string part, description, colorName;
  int color = 16;
  int step = 0;              ///< its step in the root model, from 0
  std::string submodelPath;  ///< the submodels it sits in, outermost first, joined by "/"; "" in the root
  bool inSharedSubmodel = false;  ///< its submodel is used more than once: editing it changes every use
  Vec3 position;             ///< where it is in the model, LDU
};

/// What the panes show of a session, made again only when the document or the selection changes.
struct Snapshot {
  uint64_t version = 0;  ///< the session's version (edits, undo and redo; not selection or hiding)
  size_t pieces = 0;
  std::vector<uint32_t> selection;  ///< sorted
  std::vector<PieceInfo> selected;  ///< the first 200 of the selection, described
  std::string undoName, redoName;
  bool dirty = false;
  size_t hidden = 0;
  std::string focus;  ///< the submodel being edited on its own; "" for the whole model
};

}  // namespace bmapp
