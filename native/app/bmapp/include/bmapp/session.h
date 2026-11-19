#pragma once
// One open document: its model, the engine's caches, and (later) its command log.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include <atomic>
#include "bmapp/bridging.h"
#include "bmapp/types.h"

namespace bmapp {

class Session;
}  // namespace bmapp
// Swift finds a shared reference's retain and release at global scope.
void bmappRetainSession(bmapp::Session* p);
void bmappReleaseSession(bmapp::Session* p);
namespace bmapp {

/// Swift shares one Session by reference (its address never changes, which a Viewport relies
/// on); C++ may also own one directly.
class Session {
 public:
  /// For Swift: a new session with one reference, which Swift then owns.
  static Session* create() SWIFT_RETURNS_RETAINED;
  Session();
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  /// BM_LDRAW_DIR, else public/ldraw in the working directory or one above it, else (a developer
  /// build) the repository's public/ldraw; "" if none.
  static std::string ldrawDirectory();
  /// The engine's version, "major.minor.patch".
  static std::string engineVersion();
  /// Any format bm::io reads. On failure the session is left as it was. Opening (open or
  /// openBytes) starts afresh: no undo, nothing selected or hidden, a new generation.
  OpenResult open(const std::string& path);
  /// A .brickmotion project's bytes; `path` names it (title, errors, the planner's style).
  OpenResult openBytes(const std::string& bytes, const std::string& path);
  /// Different for every document opened, in any session.
  uint64_t generation() const;
  /// The document as a .brickmotion project the web app opens: the opened project with its plan
  /// replaced (its planned "timelines" dropped once the plan has changed). An LDraw import's
  /// colour-16 parts take the colour they show, wherever all their uses agree.
  std::string projectBytes() const;
  /// The document as an LDraw MPD.
  std::string mpdBytes() const;
  size_t pieceCount() const;
  /// The file's name without its extension.
  std::string title() const;
  /// True unless the file was a .brickmotion project (an import opens as a new project).
  bool imported() const;
  /// The distinct known pieces of `pieces` and their parts.
  Summary summarize(const std::vector<uint32_t>& pieces) const;
  // Editing. Pieces are indexes into the current model. Every edit is a command on the document
  // (never on the model directly), undone exactly. A piece inside a submodel is edited in the
  // submodel, so every use of it changes; a selection that holds every piece of one use edits
  // that use instead.

  /// Moves by a world offset. `continuing`: part of one drag, which undoes as one step.
  Changed move(const std::vector<uint32_t>& pieces, Vec3 deltaLdu, bool continuing);
  /// Turns about a world axis through a world point, right-handed, in degrees.
  Changed rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing);
  Changed recolor(const std::vector<uint32_t>& pieces, int colorCode);
  Changed remove(const std::vector<uint32_t>& pieces);
  /// Copies go into the same def and step as each original, offset in the world. The copies are
  /// selected after (paste too).
  Changed duplicate(const std::vector<uint32_t>& pieces, Vec3 offsetLdu);
  /// LDraw text: a type-1 line per piece, at its place in the world.
  std::string copy(const std::vector<uint32_t>& pieces) const;
  /// Into the root model's last step, offset in the world.
  Changed paste(const std::string& ldrawText, Vec3 offsetLdu);
  Changed replacePart(const std::vector<uint32_t>& pieces, const std::string& part);
  /// Forks the submodel use holding `piece` into "<name> 2" (the next free number).
  Changed makeUnique(uint32_t piece);
  // Steps, of the model being edited. Steps are counted from 0 here; people see them from 1.

  size_t stepCount() const;
  StepFields stepFields(size_t at) const;
  /// An empty step before `at` (`at` == stepCount() adds one at the end).
  Changed insertStep(size_t at);
  /// Its pieces join the step before (the next one when it is the first); notes are joined.
  Changed deleteStep(size_t at);
  Changed moveStep(size_t from, size_t to);
  /// The items of step `at` that hold these pieces go to a new step after it, in their order.
  Changed splitStep(size_t at, const std::vector<uint32_t>& pieces);
  /// Step `first + 1` joins step `first`.
  Changed mergeSteps(size_t first);
  /// `continuing`: part of one editing session (typing), which undoes as one step.
  Changed setStepFields(size_t at, const StepFields& fields, bool continuing);
  /// To the end of `step` (stepCount() makes a new last step). A piece inside a submodel moves
  /// only with its whole use.
  Changed moveToStep(const std::vector<uint32_t>& pieces, size_t step);
  Changed reorderInStep(size_t step, size_t from, size_t to);
  // Submodels. Pieces moved between models keep where they are in the world.

  /// `preferred`, else "<preferred> 2", 3, ...: the first name no submodel has.
  std::string freeSubmodelName(const std::string& preferred) const;
  /// An empty submodel with one empty step, used nowhere yet.
  Changed newSubmodel(const std::string& name);
  /// The items holding these pieces (a whole use counts as its use) become a new submodel, one
  /// step per step they were in; one use of it takes their place. They stay selected.
  Changed makeSubmodel(const std::vector<uint32_t>& pieces, const std::string& name);
  /// The use holding `piece` is replaced by copies of its submodel's items, in its place.
  Changed extract(uint32_t piece);
  /// To the last step of `submodel`, through its first use in this model.
  Changed moveToModel(const std::vector<uint32_t>& pieces, const std::string& submodel);
  /// Every use follows.
  Changed renameSubmodel(const std::string& from, const std::string& to);
  /// Only one that is not used.
  Changed deleteSubmodel(const std::string& submodel);
  /// Ends a drag: the next continuing move or turn starts a new undo step.
  void endGesture();
  bool canUndo() const;
  bool canRedo() const;
  /// "Move Piece", "Recolour 3 Pieces", ...; "" when there is none.
  std::string undoName() const;
  std::string redoName() const;
  Changed undo();
  Changed redo();
  /// Changed since the last markSaved (or since opening).
  bool dirty() const;
  void markSaved();
  /// Goes up with every change, undo and redo included.
  uint64_t version() const;
  /// How many steps undo can go back: a growing drag leaves it, a new step raises it.
  size_t undoDepth() const;

  // Selection and hiding are view state: not commands, not undone, not saved. Both follow the
  // pieces through edits (a piece deleted drops out).

  void select(const std::vector<uint32_t>& pieces, SelectMode mode);
  /// Every piece not hidden.
  void selectAll();
  void selectNone();
  std::vector<uint32_t> selection() const;
  /// Hidden pieces are neither drawn nor picked, whatever the build's playback shows.
  void hide(const std::vector<uint32_t>& pieces);
  void showAll();
  std::vector<uint32_t> hidden() const;
  /// The piece's own axes in the model, each made unit (the gizmo's local axes); identity for none.
  Mat3 axesOf(uint32_t piece) const;
  /// The pieces of the root model's use that holds `piece` (just `piece` when it is in the root).
  std::vector<uint32_t> usePieces(uint32_t piece) const;
  /// Library parts whose name and description hold every word of `query`: an exact name first,
  /// then the closest descriptions. Moved and obsolete parts (~) are left out. The first call reads
  /// the library's part list (once per library, for every session).
  std::vector<PartMatch> searchParts(const std::string& query, size_t limit) const;
  /// Cheap: made once per version and selection change.
  Snapshot snapshot() const;

  /// This session's address, so a caller can check a Viewport was made against it.
  uintptr_t address() const { return reinterpret_cast<uintptr_t>(this); }

  struct Impl;
  Impl& impl() const { return *impl_; }
  /// The current document's state, kept alive by whoever holds it (a viewport, a planning run)
  /// after a reopen replaces it.
  std::shared_ptr<Impl> shared() const { return impl_; }

 private:
  friend void ::bmappRetainSession(Session*);
  friend void ::bmappReleaseSession(Session*);
  std::atomic<int> refs_{1};
  std::shared_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainSession, bmappReleaseSession);

}  // namespace bmapp
