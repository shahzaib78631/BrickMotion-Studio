// bmview: one model in a window, drawn by the Metal viewport.
#import <AppKit/AppKit.h>

#include <cstdio>
#include <cstring>
#include "bm/plan/timeline.h"
#import "AppDelegate.h"

int main(int argc, char** argv) {
  const char* file = nullptr;
  bool play = false, raytracedGlass = false, rtpt = false, noPlan = false, correct = false, cleanGrown = false;
  bm::plan::Order order = bm::plan::Order::Reverse;
  bm::plan::FlightShape flight = bm::plan::FlightShape::Auto;
  bm::plan::Planner planner = bm::plan::Planner::Native;
  BmViewWorldLaunch wl;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--play") == 0) play = true;
    else if (std::strcmp(argv[i], "--raytraced-glass") == 0) raytracedGlass = true;
    else if (std::strcmp(argv[i], "--no-raytraced-glass") == 0) raytracedGlass = false;
    else if (std::strcmp(argv[i], "--rtpt") == 0) rtpt = true;
    else if (std::strcmp(argv[i], "--no-plan") == 0) noPlan = true;
    else if (std::strcmp(argv[i], "--correct") == 0) correct = true;
    else if (std::strcmp(argv[i], "--clean-grown") == 0) cleanGrown = true;
    else if (std::strcmp(argv[i], "--no-clean-grown") == 0) cleanGrown = false;
    else if (std::strcmp(argv[i], "--clay") == 0) wl.clay = true;
    else if (std::strcmp(argv[i], "--studio-rig") == 0) wl.studioRig = true;
    else if (std::strcmp(argv[i], "--floor") == 0) wl.floor = true, wl.floorExplicit = true;
    else if (std::strcmp(argv[i], "--no-floor") == 0) wl.floor = false, wl.floorExplicit = true;
    else if (std::strcmp(argv[i], "--hdr") == 0 && i + 1 < argc) wl.hdrPath = argv[++i];
    else if (std::strcmp(argv[i], "--eye") == 0 && i + 1 < argc) {
      if (std::sscanf(argv[++i], "%lf,%lf,%lf", &wl.eye[0], &wl.eye[1], &wl.eye[2]) == 3) wl.hasEye = true;
    }
    else if (std::strcmp(argv[i], "--target") == 0 && i + 1 < argc) {
      std::sscanf(argv[++i], "%lf,%lf,%lf", &wl.target[0], &wl.target[1], &wl.target[2]);
    }
    else if (std::strcmp(argv[i], "--fov") == 0 && i + 1 < argc) wl.fovDeg = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--neural") == 0) setenv("BM_NEURAL", "1", 1);
    else if (std::strcmp(argv[i], "--no-neural") == 0) setenv("BM_NEURAL", "0", 1);
    else if (std::strcmp(argv[i], "--order") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], order)) i++;
    else if (std::strcmp(argv[i], "--flight") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], flight)) i++;
    else if (std::strcmp(argv[i], "--planner") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], planner)) i++;
    else if (argv[i][0] == '-' && argv[i][1] == '-') file = nullptr, i = argc;  // unknown option
    else if (!file) file = argv[i];
  }
  if (!file) {
    std::fprintf(stderr, "usage: bmview <model/3D scene (.ldr|.mpd|.io|.glb|.gltf|.obj)> [--play] [--rtpt] [--no-plan] [--clay] [--studio-rig] [--floor|--no-floor] [--hdr <file.hdr>] [--eye x,y,z --target x,y,z] [--fov deg]\n");
    return 2;
  }
  @autoreleasepool {
    NSApplication* app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyRegular;
    AppDelegate* delegate = [[AppDelegate alloc] initWithFile:[NSString stringWithUTF8String:file] play:play raytracedGlass:raytracedGlass rtpt:rtpt noPlan:noPlan correct:correct cleanGrown:cleanGrown order:order flight:flight planner:planner worldLaunch:wl];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
