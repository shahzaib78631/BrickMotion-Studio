#pragma once

#include <atomic>
#include <memory>
#include "bmapp/bridging.h"
#include "bmapp/types.h"

namespace bmapp { class Viewport; class MotionAudit; }
void bmappRetainMotionAudit(bmapp::MotionAudit*);
void bmappReleaseMotionAudit(bmapp::MotionAudit*);

namespace bmapp {

struct MotionAuditResult {
  uint32_t a = UINT32_MAX, b = UINT32_MAX;
  int collisionFrame = -1, testedFrames = 0, stride = 1;
  std::string part, blocker, error;
};

/// A snapshot of the live animation at the time the user asked to check it.
class MotionAudit {
 public:
  ~MotionAudit();
  MotionAuditResult check();

 private:
  friend class Viewport;
  friend void ::bmappRetainMotionAudit(MotionAudit*);
  friend void ::bmappReleaseMotionAudit(MotionAudit*);
  struct Impl;
  explicit MotionAudit(std::unique_ptr<Impl>);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainMotionAudit, bmappReleaseMotionAudit);

}  // namespace bmapp
