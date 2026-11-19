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

  /// BM_LDRAW_DIR, else public/ldraw in the working directory or one above it; "" if none.
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
