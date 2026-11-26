// The snap track under a picture-only movie: ported from the Swift app's MovieAudioMux.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include "bmapp/movie_export.h"

#include <string>

// AVFoundation's synchronous getters and the block-based export are deprecated in favour of
// Swift concurrency; each is waited on here, on a helper thread, as the Swift code awaited it.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

namespace bmapp {
namespace {

NSURL* fileURL(const std::string& path) { return [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]]; }

std::string encodeAAC(NSURL* source, NSURL* destination) {
  NSError* error = nil;
  AVAudioFile* input = [[AVAudioFile alloc] initForReading:source error:&error];
  if (!input) return "The snap track could not be read.";
  AVAudioFormat* format = input.processingFormat;
  NSDictionary* settings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(format.sampleRate),
    AVNumberOfChannelsKey : @(format.channelCount),
    AVEncoderBitRateKey : @192000,
  };
  AVAudioFile* output = [[AVAudioFile alloc] initForWriting:destination settings:settings
                                               commonFormat:format.commonFormat interleaved:format.isInterleaved error:&error];
  if (!output) return error ? std::string(error.localizedDescription.UTF8String) : "The snap track could not be read.";
  AVAudioPCMBuffer* buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:8192];
  if (!buffer) return "The snap track could not be read.";
  while (input.framePosition < input.length) {
    if (![input readIntoBuffer:buffer error:&error]) return error.localizedDescription.UTF8String;
    if (buffer.frameLength == 0) return "The snap track ended before it could be read.";
    if (![output writeFromBuffer:buffer error:&error]) return error.localizedDescription.UTF8String;
  }
  return "";
}

CMTime loadDuration(AVURLAsset* asset) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:@[ @"duration", @"tracks" ] completionHandler:^{
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  return asset.duration;
}

bool insert(AVMediaType type, AVURLAsset* source, CMTime duration, AVMutableComposition* composition) {
  AVAssetTrack* original = [source tracksWithMediaType:type].firstObject;
  AVMutableCompositionTrack* track = [composition addMutableTrackWithMediaType:type preferredTrackID:kCMPersistentTrackID_Invalid];
  if (!original || !track) return false;
  return [track insertTimeRange:CMTimeRangeMake(kCMTimeZero, duration) ofTrack:original atTime:kCMTimeZero error:nil];
}

}  // namespace

std::string muxSnapAudio(const std::string& video, const std::string& wave, const std::string& destination) {
  @autoreleasepool {
    NSURL* waveURL = fileURL(wave);
    NSURL* compressed = [[waveURL URLByDeletingPathExtension] URLByAppendingPathExtension:@"m4a"];
    if (auto failure = encodeAAC(waveURL, compressed); !failure.empty()) return failure;
    AVURLAsset* picture = [AVURLAsset URLAssetWithURL:fileURL(video) options:nil];
    AVURLAsset* sound = [AVURLAsset URLAssetWithURL:compressed options:nil];
    const CMTime videoDuration = loadDuration(picture);
    const CMTime audioDuration = loadDuration(sound);
    AVMutableComposition* composition = [AVMutableComposition composition];
    if (!insert(AVMediaTypeVideo, picture, videoDuration, composition)) return "The movie is missing its picture track.";
    if (!insert(AVMediaTypeAudio, sound, CMTimeMinimum(videoDuration, audioDuration), composition))
      return "The movie is missing its snap audio track.";
    AVAssetExportSession* exporter = [[AVAssetExportSession alloc] initWithAsset:composition
                                                                      presetName:AVAssetExportPresetPassthrough];
    if (!exporter) return "The movie and snap track could not be combined.";
    exporter.outputURL = fileURL(destination);
    exporter.outputFileType = AVFileTypeMPEG4;
    exporter.shouldOptimizeForNetworkUse = YES;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [exporter exportAsynchronouslyWithCompletionHandler:^{
      dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    if (exporter.status != AVAssetExportSessionStatusCompleted)
      return exporter.error ? exporter.error.localizedDescription.UTF8String : "The movie and snap track could not be combined.";
    return "";
  }
}

}  // namespace bmapp

#pragma clang diagnostic pop
