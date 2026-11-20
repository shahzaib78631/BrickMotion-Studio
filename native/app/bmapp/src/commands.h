#pragma once
// Commands on the document and their undo. A command stores the before and after of each item it
// touches, where items were inserted and removed, and the defs it added; undo restores those, and
// no command is ever replayed from scratch.
#include <optional>
#include <string>
#include <vector>
#include "bm/doc/source.h"
#include "bmapp/session.h"
#include "bmapp/types.h"

namespace bmapp {

/// One item a command changed. Both: changed in place. Only `after`: inserted at (def, step,
/// index) of the state after. Only `before`: removed from (def, step, index) of the state before.
struct ItemEdit {
  std::string def;  ///< "" = the root
  size_t step = 0, index = 0;
  std::optional<bm::doc::Item> before, after;
  // A moved or turned item, so a drag can grow: its after is made again from its before.
  bool target = false;
  bm::Xform parent;       ///< the world placement of its def, through the use it was picked in
  bm::Xform beforeLocal;  ///< its placement in its def, before
  bm::Box body;           ///< its box, for the grid rule
};

/// A def a command added (Make Unique), at this place among the submodels.
struct DefEdit {
  std::string name;
  size_t position = 0;
  bm::doc::Def def;
};

/// A def swapped whole, for edits of its steps. Both: its content replaced. Only `after`: added
/// to the submodels at `position`. Only `before`: removed. "" is the root (position unused).
struct DefChange {
  std::string name;
  size_t position = 0;
  std::optional<bm::doc::Def> before, after;
};

struct Command {
  Edit kind = Edit::Move;
  std::string name;
  std::vector<ItemEdit> items;
  std::vector<DefEdit> defs;
  std::vector<bm::ldraw::File> importedParts;
  bool addedRootStep = false;  ///< a step added to the end of `stepDef` for a paste
  std::string stepDef;         ///< the def a paste went into ("" the root)
  std::string renamedFrom, renamedTo;  ///< a rename, which the focus path follows
  std::vector<DefChange> wholeDefs;  ///< applied after the item edits, in order
  struct PlanField {
    std::string key;
    nlohmann::ordered_json before, after;
  };
  std::optional<PlanField> planField;
  size_t stepIndex = 0;               ///< a step-fields edit: which step, so typing can grow it
  // An open drag: continuing moves and turns of the same pieces grow it.
  bool open = false;
  std::vector<uint32_t> pieces;
  bm::Vec3 total, axis, pivot;
  double degrees = 0;
};

struct History {
  std::vector<Command> done;
  size_t cursor = 0;  ///< done[0, cursor) are applied
  long saved = 0;     ///< the cursor when last saved; -1 when that state can never come back
};

/// Makes the flat model and its indexes from the document again.
void reflatten(Session::Impl& s);
Changed turnWaitingPartCommand(Session::Impl& s, uint32_t piece, double degrees);

Changed moveCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 delta, bool continuing);
Changed rotateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 axis, double degrees, bm::Vec3 pivot, bool continuing);
Changed recolorCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, int code);
Changed removeCommand(Session::Impl& s, const std::vector<uint32_t>& pieces);
Changed duplicateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 offset);
std::string copyText(const Session::Impl& s, const std::vector<uint32_t>& pieces);
Changed pasteCommand(Session::Impl& s, const std::string& def, const std::string& text, bm::Vec3 offset);
Changed placePartCommand(Session::Impl& s, const std::string& def, const std::string& part,
                         int color, const bm::Xform& pose, int step);
Changed placeMovedCommand(Session::Impl& s, const PieceList& pieces, uint32_t anchor, const bm::Xform& pose);

struct MovingPiece;
std::vector<MovingPiece> piecesAfterMove(const Session::Impl& s, const PieceList& pieces, uint32_t anchor);
std::string groupOf(const bm::doc::Item& item);
Changed setGroupCommand(Session::Impl& s, const PieceList& pieces, const std::string& group);
StringList groupsOfItems(const Session::Impl& s, const PieceList& pieces);
Changed importModelCommand(Session::Impl& s, const std::string& into, const bm::doc::Source& incoming,
                           const std::string& name);
Changed replaceCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, const std::string& part);
Changed makeUniqueCommand(Session::Impl& s, uint32_t piece);
// Steps of one def ("" the root).
size_t stepCountOf(const Session::Impl& s, const std::string& def);
StepFields stepFieldsOf(const Session::Impl& s, const std::string& def, size_t at);
Changed insertStepCommand(Session::Impl& s, const std::string& def, size_t at);
Changed deleteStepCommand(Session::Impl& s, const std::string& def, size_t at);
Changed moveStepCommand(Session::Impl& s, const std::string& def, size_t from, size_t to);
Changed splitStepCommand(Session::Impl& s, const std::string& def, size_t at, const std::vector<uint32_t>& pieces);
Changed mergeStepsCommand(Session::Impl& s, const std::string& def, size_t first);
Changed setStepFieldsCommand(Session::Impl& s, const std::string& def, size_t at, const StepFields& fields, bool continuing);
MotionFields motionFieldsOf(const Session::Impl& s, MotionScope scope, size_t step, const PieceList& pieces);
Changed setMotionFieldsCommand(Session::Impl& s, MotionScope scope, size_t step, const PieceList& pieces, const MotionFields& fields);
Changed setInsertionDirectionCommand(Session::Impl& s, const PieceList& pieces, bm::Vec3 direction);
bm::Vec3 insertionDirectionOf(const Session::Impl& s, uint32_t piece);
Changed scaleCommand(Session::Impl& s, const PieceList& pieces, bm::Vec3 factor, bm::Mat3 axes, bm::Vec3 pivot, bool continuing);
Changed setKeySceneCommand(Session::Impl& s, const KeyScene& scene);
Changed setKeysCommand(Session::Impl& s, uint32_t piece, const KeyList& keys, bool continuing, bool remove, bool baked = false);
Changed moveKeyCommand(Session::Impl& s, uint32_t piece, KeyChannel channel, int from, int to);
Changed moveToStepCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, size_t step);
Changed reorderInStepCommand(Session::Impl& s, const std::string& def, size_t step, size_t from, size_t to, bool pin = false);
Changed regenerateStepsCommand(Session::Impl& s, const PieceList& buildOrder);

// Submodels, inside def `def` (the model being edited).
std::string freeName(const Session::Impl& s, const std::string& preferred);
Changed newSubmodelCommand(Session::Impl& s, const std::string& name);
Changed makeSubmodelCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, const std::string& name);
Changed extractCommand(Session::Impl& s, const std::string& def, uint32_t piece);
Changed moveToModelCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, const std::string& target);
Changed renameSubmodelCommand(Session::Impl& s, const std::string& from, const std::string& to);
Changed deleteSubmodelCommand(Session::Impl& s, const std::string& name);

/// The def being edited: the last of the focus path, or "" for the root.
std::string focusedDef(const Session::Impl& s);
/// Cuts the focus path to defs that still lead somewhere; true when it changed.
bool trimFocus(Session::Impl& s);
/// Sets the focus path, cut to its longest part that still leads somewhere; reflattens.
Changed focusCommand(Session::Impl& s, const std::vector<std::string>& path);

/// "Light_Bluish_Grey" as people read it: "Light Bluish Grey".
std::string colorDisplayName(std::string name);

/// Nothing changed.
Changed unchanged(const Session::Impl& s);
/// Refused, with the reason.
Changed refusal(const Session::Impl& s, std::string reason);

Changed undoCommand(Session::Impl& s);
Changed redoCommand(Session::Impl& s);

}  // namespace bmapp
