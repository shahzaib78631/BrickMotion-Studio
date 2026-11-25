#import <AVFoundation/AVFoundation.h>
#import <Accelerate/Accelerate.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <exception>
#include <memory>
#include <stdexcept>
#include "movie_encoder.h"

namespace bmtools {
namespace {

std::runtime_error movieError(AVAssetWriter* writer, const char* fallback) {
  const char* description = writer.error.localizedDescription.UTF8String;
  return std::runtime_error(description ? description : fallback);
}

bool appendImage(AVAssetWriterInputPixelBufferAdaptor* adaptor, bmr::Image& image, CMTime time) {
  CVPixelBufferRef buffer = nullptr;
  if (!adaptor.pixelBufferPool || CVPixelBufferPoolCreatePixelBuffer(nullptr, adaptor.pixelBufferPool, &buffer) != kCVReturnSuccess) return false;
  if (CVPixelBufferLockBaseAddress(buffer, 0) != kCVReturnSuccess) {
    CVPixelBufferRelease(buffer);
    return false;
  }
  const auto width = static_cast<vImagePixelCount>(image.width), height = static_cast<vImagePixelCount>(image.height);
  const vImage_Buffer source{image.rgba.data(), height, width, static_cast<size_t>(width) * 4};
  const vImage_Buffer destination{CVPixelBufferGetBaseAddress(buffer), height, width, CVPixelBufferGetBytesPerRow(buffer)};
  const uint8_t rgbaToBgra[4] = {2, 1, 0, 3};
  const bool copied = vImagePermuteChannels_ARGB8888(&source, &destination, rgbaToBgra, kvImageNoFlags) == kvImageNoError;
  CVPixelBufferUnlockBaseAddress(buffer, 0);
  if (copied) {
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_sRGB, kCVAttachmentMode_ShouldPropagate);
  }
  const bool appended = copied && [adaptor appendPixelBuffer:buffer withPresentationTime:time];
  CVPixelBufferRelease(buffer);
  return appended;
}

}  // namespace

void encodeMovie(const std::filesystem::path& output, int width, int height, int fps, int frames,
                 const std::function<bmr::Image(int)>& draw, int bitRate) {
  @autoreleasepool {
    NSURL* url = [NSURL fileURLWithFileSystemRepresentation:output.c_str() isDirectory:NO relativeToURL:nil];
    NSError* error = nil;
    AVAssetWriter* writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:&error];
    if (!writer) {
      const char* reason = error.localizedDescription.UTF8String;
      throw std::runtime_error(reason ? reason : "The output file could not be opened.");
    }
    writer.shouldOptimizeForNetworkUse = YES;
    NSDictionary* settings = @{
      AVVideoCodecKey: AVVideoCodecTypeH264, AVVideoWidthKey: @(width), AVVideoHeightKey: @(height),
      AVVideoColorPropertiesKey: @{
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
      },
      AVVideoCompressionPropertiesKey: @{
        AVVideoAverageBitRateKey: @(bitRate > 0 ? bitRate : std::max(800'000, width * height * fps / 5)),
        AVVideoExpectedSourceFrameRateKey: @(fps), AVVideoMaxKeyFrameIntervalKey: @(fps * 2)
      }
    };
    if (![writer canApplyOutputSettings:settings forMediaType:AVMediaTypeVideo]) throw movieError(writer, "This frame size and frame rate cannot be encoded.");
    AVAssetWriterInput* video = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    if (![writer canAddInput:video]) throw movieError(writer, "The video track could not be created.");
    [writer addInput:video];
    AVAssetWriterInputPixelBufferAdaptor* buffers = [AVAssetWriterInputPixelBufferAdaptor
      assetWriterInputPixelBufferAdaptorWithAssetWriterInput:video sourcePixelBufferAttributes:@{
        (__bridge NSString*)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (__bridge NSString*)kCVPixelBufferWidthKey: @(width), (__bridge NSString*)kCVPixelBufferHeightKey: @(height)
      }];
    if (![writer startWriting]) throw movieError(writer, "The video encoder could not start.");
    [writer startSessionAtSourceTime:kCMTimeZero];

    const auto queue = dispatch_queue_create("studio.brickmotion.movie-encoder", DISPATCH_QUEUE_SERIAL);
    const auto done = dispatch_semaphore_create(0);
    struct State {
      int frame = 0;
      bool terminal = false;
      std::exception_ptr failure;
      std::chrono::steady_clock::time_point lastReport{};
    };
    auto state = std::make_shared<State>();
    auto drawFrame = draw;
    [video requestMediaDataWhenReadyOnQueue:queue usingBlock:^{
      if (state->terminal) return;
      try {
        while (video.readyForMoreMediaData && state->frame < frames) {
          @autoreleasepool {
            const int frame = state->frame;
            auto image = drawFrame(frame);
            if (image.empty() || image.width != width || image.height != height) throw std::runtime_error("The renderer returned an incomplete frame.");
            if (!appendImage(buffers, image, CMTimeMake(frame, fps))) throw movieError(writer, "A rendered frame could not be encoded.");
            ++state->frame;
            const auto now = std::chrono::steady_clock::now();
            if (state->frame == 1 || state->frame == frames || now - state->lastReport >= std::chrono::milliseconds(120)) {
              std::printf("frame %d %d\n", state->frame, frames);
              std::fflush(stdout);
              state->lastReport = now;
            }
          }
        }
        if (state->frame == frames) {
          state->terminal = true;
          [writer endSessionAtSourceTime:CMTimeMake(frames, fps)];
          [video markAsFinished];
          [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        }
      } catch (...) {
        state->terminal = true;
        state->failure = std::current_exception();
        [writer cancelWriting];
        dispatch_semaphore_signal(done);
      }
    }];
    // If the encoder fails asynchronously while applying backpressure, its ready callback may
    // stop. Check its status while waiting so that the helper can still deliver the error.
    while (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) {
      if (writer.status == AVAssetWriterStatusFailed || writer.status == AVAssetWriterStatusCancelled) {
        dispatch_sync(queue, ^{ state->terminal = true; });
        break;
      }
    }
    if (state->failure) std::rethrow_exception(state->failure);
    if (writer.status != AVAssetWriterStatusCompleted) throw movieError(writer, "The movie could not be finalized.");
  }
}

}  // namespace bmtools
