// The recorder's state, shared with its Objective-C++ test (which puts a writer into a failed
// state the C interface cannot reach). Objective-C++ with ARC only.
#pragma once

#import <AVFoundation/AVFoundation.h>

struct BmRecorder {
  AVAssetWriter* writer = nil;
  AVAssetWriterInput* input = nil;
  AVAssetWriterInputPixelBufferAdaptor* adaptor = nil;
  int width = 0, height = 0;
  double last = 0;
};
