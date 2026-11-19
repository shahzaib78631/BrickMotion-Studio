// bmview: one model in a window, drawn by the Metal viewport.
#import <AppKit/AppKit.h>

#include <cstdio>
#include <cstring>
#import "AppDelegate.h"

int main(int argc, char** argv) {
  const char* file = nullptr;
  bool play = false, raytracedGlass = false, correct = false;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--play") == 0) play = true;
    else if (std::strcmp(argv[i], "--raytraced-glass") == 0) raytracedGlass = true;
    else if (std::strcmp(argv[i], "--correct") == 0) correct = true;
    else if (argv[i][0] == '-' && argv[i][1] == '-') file = nullptr, i = argc;  // unknown option
    else if (!file) file = argv[i];
  }
  if (!file) {
    std::fprintf(stderr, "usage: bmview <model file> [--play] [--raytraced-glass] [--correct]\n");
    return 2;
  }
  @autoreleasepool {
    NSApplication* app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyRegular;
    AppDelegate* delegate = [[AppDelegate alloc] initWithFile:[NSString stringWithUTF8String:file] play:play raytracedGlass:raytracedGlass correct:correct];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
