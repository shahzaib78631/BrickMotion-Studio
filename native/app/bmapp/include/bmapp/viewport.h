#pragma once
// The Metal viewport of one session. Task 3 gives it drawing, the camera and playback.
#include <cstdint>
#include <memory>
#include <atomic>
#include "bmapp/bridging.h"
#include "bmapp/session.h"
#include "bmapp/types.h"

namespace bmapp {

class Viewport;
}  // namespace bmapp
// Swift finds a shared reference's retain and release at global scope.
void bmappRetainViewport(bmapp::Viewport* p);
void bmappReleaseViewport(bmapp::Viewport* p);
namespace bmapp {

class Viewport {
 public:
  /// For Swift: a viewport of `session`, which it keeps a reference to.
  static Viewport* create(Session* session) SWIFT_RETURNS_RETAINED;
  /// Draws `session`'s model; the session must outlive the viewport.
  explicit Viewport(Session& session);
  ~Viewport();
  Viewport(const Viewport&) = delete;
  Viewport& operator=(const Viewport&) = delete;

  /// False when this Mac cannot draw (no Metal device) or the session has no model.
  bool ok() const;
  /// The address of the session it was made against.
  uintptr_t sessionAddress() const;

  struct Impl;

 private:
  friend void ::bmappRetainViewport(Viewport*);
  friend void ::bmappReleaseViewport(Viewport*);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainViewport, bmappReleaseViewport);

}  // namespace bmapp
