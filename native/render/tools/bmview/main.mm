// bmview: one model in a window, drawn by the Metal viewport.
#import <AppKit/AppKit.h>

#include <cstdio>
#include <cstring>
#include "bm/plan/timeline.h"
#import "AppDelegate.h"

int main(int argc, char** argv) {
  const char* file = nullptr;
  bool play = false, raytracedGlass = false, correct = false, cleanGrown = false;
  bm::plan::Order order = bm::plan::Order::Reverse;
  bm::plan::FlightShape flight = bm::plan::FlightShape::Auto;
  bm::plan::Planner planner = bm::plan::Planner::Native;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--play") == 0) play = true;
    else if (std::strcmp(argv[i], "--raytraced-glass") == 0) raytracedGlass = true;
    else if (std::strcmp(argv[i], "--no-raytraced-glass") == 0) raytracedGlass = false;
    else if (std::strcmp(argv[i], "--correct") == 0) correct = true;
    else if (std::strcmp(argv[i], "--clean-grown") == 0) cleanGrown = true;
    else if (std::strcmp(argv[i], "--no-clean-grown") == 0) cleanGrown = false;
    else if (std::strcmp(argv[i], "--neural") == 0) setenv("BM_NEURAL", "1", 1);
    else if (std::strcmp(argv[i], "--no-neural") == 0) setenv("BM_NEURAL", "0", 1);
    else if (std::strcmp(argv[i], "--order") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], order)) i++;
    else if (std::strcmp(argv[i], "--flight") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], flight)) i++;
    else if (std::strcmp(argv[i], "--planner") == 0 && i + 1 < argc && bm::plan::parse(argv[i + 1], planner)) i++;
    else if (argv[i][0] == '-' && argv[i][1] == '-') file = nullptr, i = argc;  // unknown option
    else if (!file) file = argv[i];
  }
  if (!file) {
    std::fprintf(stderr, "usage: bmview <model file> [--play] [--raytraced-glass] [--correct] [--clean-grown|--no-clean-grown] [--order reverse|forward] [--flight auto|web|arc] [--planner native|legacy]\n");
    return 2;
  }
  @autoreleasepool {
    NSApplication* app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyRegular;
    AppDelegate* delegate = [[AppDelegate alloc] initWithFile:[NSString stringWithUTF8String:file] play:play raytracedGlass:raytracedGlass correct:correct cleanGrown:cleanGrown order:order flight:flight planner:planner];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
