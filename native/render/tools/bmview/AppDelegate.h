#pragma once
#import <AppKit/AppKit.h>
#include <string>
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

struct BmViewWorldLaunch {
  std::string hdrPath;
  bool clay = false;
  bool studioRig = false;
  bool floor = false;
  bool floorExplicit = false;
  bool hasEye = false;
  double eye[3] = {0, 0, 0};
  double target[3] = {0, 0, 0};
  double fovDeg = 0.0;
};

/// Opens one model in one window; the app ends when the window closes.
@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
- (instancetype)initWithFile:(NSString*)path play:(BOOL)play raytracedGlass:(BOOL)raytracedGlass rtpt:(BOOL)rtpt noPlan:(BOOL)noPlan correct:(BOOL)correct cleanGrown:(BOOL)cleanGrown order:(bm::plan::Order)order flight:(bm::plan::FlightShape)flight planner:(bm::plan::Planner)planner worldLaunch:(BmViewWorldLaunch)worldLaunch;
@end
