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

struct Command {
  Edit kind = Edit::Move;
  std::string name;
  std::vector<ItemEdit> items;
  std::vector<DefEdit> defs;
  bool addedRootStep = false;
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

Changed moveCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 delta, bool continuing);
Changed rotateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 axis, double degrees, bm::Vec3 pivot, bool continuing);
Changed recolorCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, int code);
Changed removeCommand(Session::Impl& s, const std::vector<uint32_t>& pieces);
Changed duplicateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 offset);
std::string copyText(const Session::Impl& s, const std::vector<uint32_t>& pieces);
Changed pasteCommand(Session::Impl& s, const std::string& text, bm::Vec3 offset);
Changed replaceCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, const std::string& part);
Changed makeUniqueCommand(Session::Impl& s, uint32_t piece);
Changed undoCommand(Session::Impl& s);
Changed redoCommand(Session::Impl& s);

}  // namespace bmapp
