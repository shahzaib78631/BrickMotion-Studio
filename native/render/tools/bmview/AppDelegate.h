#pragma once
#import <AppKit/AppKit.h>
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"

/// Opens one model in one window; the app ends when the window closes.
@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
- (instancetype)initWithFile:(NSString*)path play:(BOOL)play raytracedGlass:(BOOL)raytracedGlass correct:(BOOL)correct cleanGrown:(BOOL)cleanGrown order:(bm::plan::Order)order flight:(bm::plan::FlightShape)flight planner:(bm::plan::Planner)planner;
@end
