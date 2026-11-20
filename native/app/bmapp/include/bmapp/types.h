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

struct PartPose {
  Mat3 rotation;
  Vec3 position;
};

enum class ViewPreset { Front, Back, Right, Left, Top, Bottom };
enum class PlanState { Idle, Planning, Ready, Failed };
enum class SelectMode { Replace, Add, Toggle };
enum class Arrow { Left, Right, Up, Down };

/// The undoable edits.
enum class Edit {
  Move, Rotate, Recolor, Delete, Duplicate, Paste, ReplacePart, MakeUnique,
  AddStep, DeleteStep, MoveStep, SplitStep, MergeSteps, StepFields, MoveToStep, ReorderInStep,
  NewSubmodel, MakeSubmodel, Extract, MoveToModel, RenameSubmodel, DeleteSubmodel, PlacePart, SetGroup, ImportModel,
  Motion, InsertionDirection, Scale, Keyframes,
};

/// A step's editorial fields, as a person edits them.
struct StepFields {
  std::string title, notes;  ///< title at most 80 characters, notes 1000, both trimmed
  double pauseAfter = 0;     ///< seconds held after the step, 0–10, one decimal
  bool pinOrder = false;     ///< its pieces keep their order and stop waiting on what they rest on
};

using PieceList = std::vector<uint32_t>;

enum class MotionScope { Project, Step, Parts };
struct MotionFields {
  double time = -1, landing = -1, hover = -1;  ///< Negative fields use the enclosing value.
  int ease = -1;                             ///< -1 inherited, then smooth, gentle, soft, linear.
};

enum class KeyInterpolation { Smooth, Linear, Hold };
enum class KeyChannel { PositionX, PositionY, PositionZ, RotationX, RotationY, RotationZ, ScaleX, ScaleY, ScaleZ, Visibility };
struct Keyframe {
  KeyChannel channel = KeyChannel::PositionX;
  int frame = 1;
  double value = 0;
  KeyInterpolation interpolation = KeyInterpolation::Smooth;
};
struct KeyScene {
  int fps = 24, first = 1, last = 250;
  bool buildLinked = false;
  int buildStart = 1;
  double buildSpeed = 1;
};
using KeyList = std::vector<Keyframe>;
struct KeyTrack {
  uint32_t object = UINT32_MAX;
  std::string name;
  bool baked = false;
  KeyList keys;
  PieceList members;
};
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
  bool keyframesOnly = false;
  std::vector<uint32_t> moved;
  std::vector<uint32_t> recolored;
  std::vector<uint32_t> removed;  ///< old indices, when deletion leaves all other placements intact
  uint64_t version = 0;  ///< the session's version after it
  /// Not empty when the command was refused: nothing changed, no undo step was made, and this is
  /// why, fit to show a person.
  std::string refused;
};

/// A part file in the library.
struct PartMatch {
  std::string name, description;  ///< "3001.dat", "Brick  2 x  4"
  std::string category;
};

/// One piece, described for the inspector.
struct PieceInfo {
  uint32_t piece = 0;
  std::string part, description, colorName;
  bool inlinePart = false;
  int color = 16;
  int step = 0;              ///< its step in the root model, from 0
  std::string submodelPath;  ///< the submodels it sits in, outermost first, joined by "/"; "" in the root
  bool inSharedSubmodel = false;  ///< its submodel is used more than once: editing it changes every use
  Vec3 position;             ///< where it is in the model, LDU
};

/// A row of the models outline: the whole model, each use of a submodel under the model that
/// uses it, then the submodels used nowhere. Flat, in depth-first file order.
struct OutlineRow {
  std::string group;  ///< the mark on this use, within its parent model
  std::string id;    ///< "root"; the use items' ids from the root joined by "/"; "unused/<name>"
  std::string def;   ///< the submodel it shows; "" for the whole model
  std::string name;  ///< what to call it
  int depth = 0;
  int parent = -1;   ///< the row above it in the tree, or -1
  size_t pieces = 0;  ///< parts under it, at any depth
  size_t uses = 0;    ///< how many times its submodel is used in the file
  bool shared = false;  ///< used more than once: editing it changes every use
  bool unused = false;
  uint64_t useItem = 0;  ///< the use's item, 0 for the root and unused rows
};

/// A step of the model being edited.
struct StepRow {
  size_t index = 0;
  std::string title, notes;
  double pauseAfter = 0;
  bool pinOrder = false;
  bool automatic = false;  ///< made by splitting a step-less file, not by a person
  size_t items = 0;        ///< its parts and submodel uses
  size_t pieces = 0;       ///< the parts they make
  size_t submodels = 0;    ///< direct submodel uses in this step
};

/// An item of a step: a part, or a use of a submodel.
struct ItemRow {
  uint64_t item = 0;
  std::string name, description, colorName, group;
  int color = 16;
  bool submodel = false;
  size_t step = 0, index = 0;
  std::vector<uint32_t> pieces;  ///< the pieces it makes in the model being edited
};

enum class Similar { Part, Color, PartAndColor, Step };

/// A colour of the library's table.
struct ColorInfo {
  int code = 0;
  std::string name;
  uint32_t rgb = 0;  ///< 0xRRGGBB
  float alpha = 1;
  int group = 0;     ///< 0 solid, 1 transparent, 2 metallic (chrome, pearl, metal), 3 other
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
