#pragma once
// The Metal viewport of one session: drawing, the camera, and playing the build.
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
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

/// The camera as the viewport holds it. yaw 0 looks at the model's front (from -z); positive
/// pitch looks down from above. Lengths in LDU.
struct CameraState {
  double yaw = 0, pitch = 0, distance = 0;
  Vec3 target;
  bool orthographic = false;  ///< not drawn yet: the renderer has perspective only
};

/// A drawn picture, top row first, 8-bit sRGB RGBA.
struct Picture {
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;
};

class Viewport {
 public:
  /// For Swift: a viewport of `session`, which it keeps a reference to.
  static Viewport* create(Session* session) SWIFT_RETURNS_RETAINED;
  /// The Metal device every viewport draws with (an id<MTLDevice>), for the view's CAMetalLayer;
  /// null when this Mac cannot draw.
  static void* metalDevice();
  /// Draws `session`'s model; the session must outlive the viewport.
  explicit Viewport(Session& session);
  ~Viewport();
  Viewport(const Viewport&) = delete;
  Viewport& operator=(const Viewport&) = delete;

  /// False when this Mac cannot draw (no Metal device) or the session has no model.
  bool ok() const;
  /// The address of the session it was made against.
  uintptr_t sessionAddress() const;

  /// The picture's size in pixels, and pixels per point (2 on a Retina screen).
  void resize(int pixelsWide, int pixelsHigh, double backingScale);
  /// Draws a frame into `metalDrawable` (an id<CAMetalDrawable>), or into the viewport's own
  /// picture when null (see readback). True when another frame is wanted soon: playing, a map
  /// still being drawn over frames, or a frame that could not be sent.
  bool draw(void* metalDrawable);
  /// The last frame drawn with no drawable.
  Picture readback();
  /// Behind the model, as sRGB 0..1 (the view follows light and dark mode).
  void setBackground(double r, double g, double b);
  /// True when something has changed since the last frame drawn.
  bool needsDraw() const;

  /// Turns the view as if the pointer had hold of the model's near side: a drag of this many
  /// points, right and down positive.
  void orbit(double dxPoints, double dyPoints);
  /// Slides the view by a drag of this many points, right and down positive.
  void pan(double dxPoints, double dyPoints);
  /// Distance is divided by `factor` (above 1 comes closer), within the renderer's limits.
  void zoom(double factor);
  /// As zoom, keeping the point under (xPoints, yPoints), from the top left, where it is.
  void zoomToward(double factor, double xPoints, double yPoints);
  /// A trackpad rotation, counterclockwise positive, turns the view about the vertical.
  void rotateGesture(double degrees);
  /// Everything in view, from where the camera is looking now.
  void fitAll();
  /// Looks from that side, straight on, with everything in view.
  void view(ViewPreset preset);
  CameraState camera() const;

  /// Space: plans the build the first time (in the background), then plays or pauses it.
  void play(bool on);
  bool playing() const;
  /// Where playback is, and how long the build is, in seconds (0 until planned).
  double seconds() const;
  double length() const;
  void seek(double seconds);
  PlanState planState() const;
  /// Why planning failed, fit to show; empty otherwise.
  std::string planError() const;
  /// The session's version the current plan was made from; 0 when there is none. An edit drops
  /// the plan (and stops a planning run), so playing again plans the edited model.
  uint64_t plannedVersion() const;

  struct Impl;

 private:
  friend void ::bmappRetainViewport(Viewport*);
  friend void ::bmappReleaseViewport(Viewport*);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainViewport, bmappReleaseViewport);

}  // namespace bmapp
