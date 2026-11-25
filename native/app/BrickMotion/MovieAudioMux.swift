import AVFoundation
import Foundation

enum MovieAudioMux {
  static func write(video: URL, snaps: URL, compressed: URL, to destination: URL) async throws {
    try encodeAAC(from: snaps, to: compressed)
    let picture = AVURLAsset(url: video)
    let sound = AVURLAsset(url: compressed)
    let composition = AVMutableComposition()
    let videoDuration = try await picture.load(.duration)
    let audioDuration = try await sound.load(.duration)
    try await insert(.video, from: picture, duration: videoDuration, into: composition)
    try await insert(.audio, from: sound, duration: CMTimeMinimum(videoDuration, audioDuration), into: composition)

    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
      throw failure("The movie and snap track could not be combined.")
    }
    export.shouldOptimizeForNetworkUse = true
    try await export.export(to: destination, as: .mp4)
  }

  private static func encodeAAC(from source: URL, to destination: URL) throws {
    let input = try AVAudioFile(forReading: source)
    let format = input.processingFormat
    let output = try AVAudioFile(forWriting: destination, settings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: Int(format.channelCount),
      AVEncoderBitRateKey: 192_000
    ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else {
      throw failure("The snap track could not be read.")
    }
    while input.framePosition < input.length {
      try input.read(into: buffer)
      guard buffer.frameLength > 0 else { throw failure("The snap track ended before it could be read.") }
      try output.write(from: buffer)
    }
  }

  private static func insert(_ type: AVMediaType, from source: AVURLAsset, duration: CMTime,
                             into composition: AVMutableComposition) async throws {
    guard let original = try await source.loadTracks(withMediaType: type).first,
          let track = composition.addMutableTrack(withMediaType: type, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      throw failure("The movie is missing its \(type == .video ? "picture" : "snap audio") track.")
    }
    try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: original, at: .zero)
  }

  private static func failure(_ text: String) -> NSError {
    NSError(domain: "BrickMotion.Movie", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
  }
}
