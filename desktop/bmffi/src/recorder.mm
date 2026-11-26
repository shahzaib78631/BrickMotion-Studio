// View → Record Viewport's encoder: viewport frames as an H.264 movie, ported from the Swift
// app's ViewportRecorder. The first size sets the movie; later frames are fitted, on black.
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cmath>
#include <string>

#include "bmffi.h"
#include "internal.h"

// AVFoundation's synchronous track getters are deprecated for Swift concurrency; a recorder is
// driven from one thread and waits where Swift would await.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

struct BmRecorder {
  AVAssetWriter* writer = nil;
  AVAssetWriterInput* input = nil;
  AVAssetWriterInputPixelBufferAdaptor* adaptor = nil;
  int width = 0, height = 0;
  double last = 0;
};

namespace {

constexpr int kFramesPerSecond = 30;
constexpr int kLargestSide = 3840;

int even(double v) { return std::max(2, static_cast<int>(std::lround(v / 2)) * 2); }

}  // namespace

extern "C" {

BmRecorder* bm_recorder_start(const char* path, int32_t width, int32_t height, BmString* error) {
  auto fail = [&](const char* why) -> BmRecorder* {
    if (error) *error = bmffi::make(why);
    return nullptr;
  };
  if (!path || width <= 0 || height <= 0) return fail("The recording has no picture.");
  @autoreleasepool {
    const double scale = std::min(1.0, double(kLargestSide) / std::max(width, height));
    auto* r = new BmRecorder;
    r->width = even(width * scale);
    r->height = even(height * scale);
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    NSError* err = nil;
    r->writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:&err];
    if (!r->writer) {
      delete r;
      return fail("The movie file could not be made.");
    }
    const long bits = std::max(4'000'000L, static_cast<long>(double(r->width) * r->height * kFramesPerSecond * 0.15));
    NSDictionary* settings = @{
      AVVideoCodecKey : AVVideoCodecTypeH264,
      AVVideoWidthKey : @(r->width),
      AVVideoHeightKey : @(r->height),
      AVVideoCompressionPropertiesKey : @{AVVideoAverageBitRateKey : @(bits), AVVideoExpectedSourceFrameRateKey : @(kFramesPerSecond)},
    };
    r->input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    r->input.expectsMediaDataInRealTime = YES;
    NSDictionary* attributes = @{
      (NSString*)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (NSString*)kCVPixelBufferWidthKey : @(r->width),
      (NSString*)kCVPixelBufferHeightKey : @(r->height),
    };
    r->adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:r->input
                                                                                   sourcePixelBufferAttributes:attributes];
    if (![r->writer canAddInput:r->input]) {
      delete r;
      return fail("The movie encoder could not start.");
    }
    [r->writer addInput:r->input];
    if (![r->writer startWriting]) {
      delete r;
      return fail("The movie encoder could not start.");
    }
    [r->writer startSessionAtSourceTime:kCMTimeZero];
    return r;
  }
}

BmFrameSize bm_recorder_size(const BmRecorder* r) { return r ? BmFrameSize{r->width, r->height} : BmFrameSize{0, 0}; }

bool bm_recorder_append(BmRecorder* r, const uint8_t* rgba, size_t len, int32_t width, int32_t height, double seconds) {
  if (!r || !rgba || width <= 0 || height <= 0 || len < size_t(width) * height * 4) return false;
  @autoreleasepool {
    // The encoder is behind: drop this frame rather than stall the editor.
    if (!r->input.readyForMoreMediaData) return false;
    CVPixelBufferPoolRef pool = r->adaptor.pixelBufferPool;
    CVPixelBufferRef buffer = nullptr;
    if (!pool || CVPixelBufferPoolCreatePixelBuffer(nullptr, pool, &buffer) != kCVReturnSuccess || !buffer) return false;
    CVPixelBufferLockBaseAddress(buffer, 0);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(buffer), r->width, r->height, 8,
                                                 CVPixelBufferGetBytesPerRow(buffer), space,
                                                 uint32_t(kCGImageAlphaNoneSkipFirst) | uint32_t(kCGBitmapByteOrder32Little));
    CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, rgba, size_t(width) * height * 4, nullptr);
    CGImageRef image = CGImageCreate(width, height, 8, 32, size_t(width) * 4, space,
                                     uint32_t(kCGImageAlphaNoneSkipLast) | uint32_t(kCGBitmapByteOrderDefault), provider,
                                     nullptr, false, kCGRenderingIntentDefault);
    bool ok = context && image;
    if (ok) {
      // Fitted, centred, on black when the window's shape has changed since the first frame.
      CGContextSetRGBFillColor(context, 0, 0, 0, 1);
      CGContextFillRect(context, CGRectMake(0, 0, r->width, r->height));
      const double fit = std::min(double(r->width) / width, double(r->height) / height);
      const double w = width * fit, h = height * fit;
      CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
      CGContextDrawImage(context, CGRectMake((r->width - w) / 2, (r->height - h) / 2, w, h), image);
    }
    if (image) CGImageRelease(image);
    CGDataProviderRelease(provider);
    if (context) CGContextRelease(context);
    CGColorSpaceRelease(space);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    if (ok) {
      ok = [r->adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMakeWithSeconds(seconds, 600)];
      if (ok) r->last = std::max(r->last, seconds);
    }
    CVPixelBufferRelease(buffer);
    return ok;
  }
}

BmString bm_recorder_finish(BmRecorder* r) {
  if (!r) return bmffi::make("Nothing was recorded.");
  std::string failure;
  @autoreleasepool {
    [r->input markAsFinished];
    [r->writer endSessionAtSourceTime:CMTimeMakeWithSeconds(r->last + 1.0 / kFramesPerSecond, 600)];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [r->writer finishWritingWithCompletionHandler:^{
      dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    if (r->writer.status != AVAssetWriterStatusCompleted)
      failure = "The movie encoder stopped. Try a smaller window.";
  }
  delete r;
  return bmffi::make(failure);
}

void bm_recorder_free(BmRecorder* r) {
  if (!r) return;
  @autoreleasepool {
    if (r->writer.status == AVAssetWriterStatusWriting) [r->writer cancelWriting];
  }
  delete r;
}

int64_t bm_movie_frame_count(const char* path) {
  if (!path) return -1;
  @autoreleasepool {
    AVURLAsset* asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] options:nil];
    AVAssetTrack* track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if (!track) return -1;
    NSError* error = nil;
    AVAssetReader* reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    if (!reader) return -1;
    AVAssetReaderTrackOutput* output = [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:track outputSettings:nil];
    if (![reader canAddOutput:output]) return -1;
    [reader addOutput:output];
    if (![reader startReading]) return -1;
    int64_t frames = 0;
    while (CMSampleBufferRef sample = [output copyNextSampleBuffer]) {
      frames += CMSampleBufferGetNumSamples(sample);
      CFRelease(sample);
    }
    return frames;
  }
}

}  // extern "C"

#pragma clang diagnostic pop
