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
  /// Any format bm::io reads. On failure the session is left empty.
  OpenResult open(const std::string& path);
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
  /// Copies go into the same def and step as each original, offset in the world.
  Changed duplicate(const std::vector<uint32_t>& pieces, Vec3 offsetLdu);
  /// LDraw text: a type-1 line per piece, at its place in the world.
  std::string copy(const std::vector<uint32_t>& pieces) const;
  /// Into the root model's last step, offset in the world.
  Changed paste(const std::string& ldrawText, Vec3 offsetLdu);
  Changed replacePart(const std::vector<uint32_t>& pieces, const std::string& part);
  /// Forks the submodel use holding `piece` into "<name> 2" (the next free number).
  Changed makeUnique(uint32_t piece);
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
  /// Cheap: made once per version and selection change.
  Snapshot snapshot() const;

  /// This session's address, so a caller can check a Viewport was made against it.
  uintptr_t address() const { return reinterpret_cast<uintptr_t>(this); }

  struct Impl;
  Impl& impl() const { return *impl_; }

 private:
  friend void ::bmappRetainSession(Session*);
  friend void ::bmappReleaseSession(Session*);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainSession, bmappReleaseSession);

}  // namespace bmapp
