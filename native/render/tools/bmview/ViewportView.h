#pragma once
// The viewport: a CAMetalLayer drawn by bmr::Renderer when something has changed, with the
// mouse and keys to look around and play the build.
#import <AppKit/AppKit.h>

#include <filesystem>
#include <memory>
#include <optional>
#include "bm/jobs.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bmr/renderer.h"
#include "engine.h"

namespace bmview {

/// Everything one window shows, owned together so that it goes together.
struct Session {
  std::filesystem::path file;
  std::string ldraw;
  std::unique_ptr<bm::ldraw::Library> library;
  std::unique_ptr<bm::ldraw::PartCache> full, low;
  std::unique_ptr<bm::Model> model;
  std::unique_ptr<bmr::Renderer> renderer;
  std::optional<bmtools::Planned> planned;  ///< set on the main thread once planning is done
  bm::CancelToken cancel;                   ///< stops planning when the window goes
  bool raytracedGlass = false;              ///< --raytraced-glass: start with ray-traced glass (G toggles it)
};

}  // namespace bmview

@interface ViewportView : NSView
- (instancetype)initWithFrame:(NSRect)frame session:(bmview::Session*)session;
/// The plan has arrived (main thread): playing is possible; with `play`, it starts.
- (void)planReady:(BOOL)play;
/// Stops drawing; called before the session goes.
- (void)stop;
@end
