// bmview: one model in a window, drawn by the Metal viewport.
#import <AppKit/AppKit.h>

#include <cstdio>
#include <cstring>
#import "AppDelegate.h"

int main(int argc, char** argv) {
  const char* file = nullptr;
  bool play = false, raytracedGlass = false, correct = false, arc = false;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--play") == 0) play = true;
    else if (std::strcmp(argv[i], "--raytraced-glass") == 0) raytracedGlass = true;
    else if (std::strcmp(argv[i], "--correct") == 0) correct = true;
    else if (std::strcmp(argv[i], "--flight") == 0 && i + 1 < argc && (std::strcmp(argv[i + 1], "arc") == 0 || std::strcmp(argv[i + 1], "web") == 0)) arc = std::strcmp(argv[++i], "arc") == 0;
    else if (argv[i][0] == '-' && argv[i][1] == '-') file = nullptr, i = argc;  // unknown option
    else if (!file) file = argv[i];
  }
  if (!file) {
    std::fprintf(stderr, "usage: bmview <model file> [--play] [--raytraced-glass] [--correct] [--flight web|arc]\n");
    return 2;
  }
  @autoreleasepool {
    NSApplication* app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyRegular;
    AppDelegate* delegate = [[AppDelegate alloc] initWithFile:[NSString stringWithUTF8String:file] play:play raytracedGlass:raytracedGlass correct:correct arc:arc];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
