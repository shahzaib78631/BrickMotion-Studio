#pragma once
#include "bmapp/viewport.h"

namespace bmapp {
class PartPreview;
}
void bmappRetainPartPreview(bmapp::PartPreview* p);
void bmappReleasePartPreview(bmapp::PartPreview* p);

namespace bmapp {

/// A worker-owned renderer and library. Keep calls on one serial executor.
class PartPreview {
 public:
  static PartPreview* create(const std::string& ldraw) SWIFT_RETURNS_RETAINED;
  explicit PartPreview(const std::string& ldraw);
  ~PartPreview();
  PartPreview(const PartPreview&) = delete;
  PartPreview& operator=(const PartPreview&) = delete;

  /// One square studio render, or an empty picture if the part or Metal is unavailable.
  Picture render(const std::string& part, int color, bool dark);
  /// A recent document on its own studio background. Empty for a missing or unreadable file.
  Picture renderModel(const std::string& file, bool dark);

 private:
  friend void ::bmappRetainPartPreview(PartPreview* p);
  friend void ::bmappReleasePartPreview(PartPreview* p);
  struct Impl;
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainPartPreview, bmappReleasePartPreview);

}  // namespace bmapp
