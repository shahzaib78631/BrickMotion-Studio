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
#include "bmr/world_renderer.h"
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
  // Native 3D World Asset (.glb/.gltf/.obj) rendered directly via WorldRenderer (no conversion).
  bool isWorld = false;
  std::unique_ptr<bmr::WorldRenderer> world;
  bmr::WorldFrameOptions worldOptions;
  bool worldHasDefaultView = false;
  bm::Vec3 worldDefaultEye{0, 0, 0};
  bm::Vec3 worldDefaultTarget{0, 0, 0};
  double worldDefaultFovDeg = 45.0;
  std::optional<bmtools::Planned> planned;  ///< set on the main thread once planning is done
  bm::CancelToken cancel;                   ///< stops planning when the window goes
  bool raytracedGlass = false;              ///< --raytraced-glass: start with ray-traced glass (G toggles it)
  bool realtimePathTrace = false;           ///< --rtpt: start with live Real-Time Path Tracing (T toggles it)
  bool noPlan = false;                      ///< --no-plan: skip LEGO build-order planning (e.g. CAD/showcase models)
  bm::plan::FlightShape flight = bm::plan::FlightShape::Auto;  ///< --flight auto|web|arc (W cycles it)
  bm::plan::Planner planner = bm::plan::Planner::Native;       ///< --planner native|legacy
};

}  // namespace bmview

@interface ViewportView : NSView
- (instancetype)initWithFrame:(NSRect)frame session:(bmview::Session*)session;
/// The plan has arrived (main thread): playing is possible; with `play`, it starts.
- (void)planReady:(BOOL)play;
/// Stops drawing; called before the session goes.
- (void)stop;
@end
