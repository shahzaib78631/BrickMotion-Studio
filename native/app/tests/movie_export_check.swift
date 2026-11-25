// Run the same headless worker used by File → Export Video and decode its output with AVFoundation.
import AVFoundation
import ImageIO
import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else {
    throw NSError(domain: "BrickMotion.MovieTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

let executable = URL(fileURLWithPath: CommandLine.arguments[1])
let root = FileManager.default.temporaryDirectory.appendingPathComponent("brickmotion-movie-\(UUID())")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: root) }

var project: [String: Any] = [
  "format": "brickmotion-project", "version": 1,
  "plan": [
    "format": "brickmotion-plan", "version": 1, "name": "Movie Fixture",
    "steps": [["pieces": [["id": "brick", "part": "3001.dat", "color": 4,
                           "ldu": [0, 0, 0], "matrix": [1, 0, 0, 0, 1, 0, 0, 0, 1]]]]],
    "animation": [
      "fps": 24, "startFrame": 1, "endFrame": 25,
      "tracks": [
        ["kind": "object", "model": "", "target": "brick",
         "channels": ["location.x": [
          ["frame": 1, "value": -0.6, "interpolation": "linear"],
          ["frame": 25, "value": 0.6, "interpolation": "linear"]
         ]]]
      ]
    ]
  ]
]
let input = root.appendingPathComponent("Fixture.brickmotion")
func writeProject() throws {
  try JSONSerialization.data(withJSONObject: project).write(to: input)
}

func render(_ name: String, _ source: String, extra: [String] = []) throws -> AVURLAsset {
  let output = root.appendingPathComponent(name + ".mp4")
  let child = Process()
  child.executableURL = executable
  child.arguments = ["--render-editor-movie", input.path, "--out", output.path, "--size", "320x180",
                     "--fps", "24", "--source", source] + extra
  child.standardOutput = FileHandle.nullDevice
  let error = Pipe()
  child.standardError = error
  try child.run()
  let errorText = String(decoding: error.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  child.waitUntilExit()
  try check(child.terminationStatus == 0, "Export \(name) failed. \(errorText)")
  return AVURLAsset(url: output)
}

try writeProject()
let keyed = try render("Keys", "keyframes", extra: ["--azimuth", "0", "--elevation", "15"])
let keyDuration = try await keyed.load(.duration)
try check(abs(keyDuration.seconds - (25.0 / 24)) < 1e-3, "The authored frame range should include both endpoints.")
let track = try await keyed.loadTracks(withMediaType: .video).first
let size = try await track?.load(.naturalSize)
try check(size?.width == 320 && size?.height == 180, "The encoded frame size changed.")
let images = AVAssetImageGenerator(asset: keyed)
images.requestedTimeToleranceBefore = .zero
images.requestedTimeToleranceAfter = .zero
let start = try await images.image(at: .zero).image
let end = try await images.image(at: CMTime(value: 24, timescale: 24)).image
try check(start.dataProvider?.data != end.dataProvider?.data, "The authored motion did not reach the encoded frames.")

let build = try render("Build", "build")
let defaultDuration = try await build.load(.duration)
project["settings"] = ["video": ["introSeconds": 3]]
try writeProject()
let held = try render("Hold", "build")
let heldDuration = try await held.load(.duration)
try check(abs(heldDuration.seconds - defaultDuration.seconds - 2) < 1.0 / 24 + 1e-3,
          "Changing the saved intro did not shift the encoded Build duration.")

let orbit = try render("Turntable", "turntable", extra: ["--duration", "1"])
let orbitDuration = try await orbit.load(.duration)
try check(abs(orbitDuration.seconds - 1) < 1e-3, "The turntable duration changed.")

let large = try render("Large Turntable", "turntable", extra: ["--duration", "0.125", "--size", "3840x2160", "--bitrate", "40000000"])
let largeTrack = try await large.loadTracks(withMediaType: .video).first
let largeSize = try await largeTrack?.load(.naturalSize)
try check(largeSize?.width == 3840 && largeSize?.height == 2160, "The larger output size did not reach the encoder.")

let sound = try render("Sound", "build", extra: ["--snap-audio"])
let audioTracks = try await sound.loadTracks(withMediaType: .audio)
let soundDuration = try await sound.load(.duration)
try check(audioTracks.count == 1, "The snap soundtrack was not included.")
try check(abs(soundDuration.seconds - heldDuration.seconds) < 1.0 / 24 + 1e-3,
          "Audio export changed the picture duration.")

func peakLevel(_ asset: AVURLAsset) async throws -> Int {
  guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return 0 }
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
  ])
  reader.add(output)
  try check(reader.startReading(), "The soundtrack could not be decoded.")
  var peak = 0
  while let samples = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(samples) {
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0, length % MemoryLayout<Int16>.size == 0 else { continue }
    var pcm = [Int16](repeating: 0, count: length / MemoryLayout<Int16>.size)
    let copied = pcm.withUnsafeMutableBytes { bytes -> Bool in
      guard let base = bytes.baseAddress else { return false }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base) == noErr
    }
    guard copied else { continue }
    for sample in pcm { peak = max(peak, abs(Int(sample))) }
  }
  try check(reader.status == .completed, "The soundtrack did not decode to completion.")
  return peak
}

let normalPeak = try await peakLevel(sound)
try check(normalPeak > 250, "The generated Build soundtrack is silent.")
project["settings"] = ["video": ["introSeconds": 3, "nativeSnapMode": "physical", "sound": ["volume": 0]]]
try writeProject()
let muted = try render("Muted", "build", extra: ["--snap-audio"])
let mutedPeak = try await peakLevel(muted)
try check(mutedPeak < normalPeak / 20, "The saved sound level did not change the exported audio.")

var plan = project["plan"] as! [String: Any]
plan["sceneSetup"] = ["cameras": [
  ["id": "wide", "name": "Wide", "kind": "camera", "position": [0, 3, 12], "target": [0, 0, 0], "fov": 42],
  ["id": "close", "name": "Close", "kind": "camera", "position": [0, 3, 12], "target": [0, 0, 0], "fov": 18]
]]
project["plan"] = plan
try writeProject()
let wide = try render("Wide", "keyframes", extra: ["--scene-camera", "wide"])
let close = try render("Close", "keyframes", extra: ["--scene-camera", "close"])
let wideFrame = try await AVAssetImageGenerator(asset: wide).image(at: .zero).image
let closeFrame = try await AVAssetImageGenerator(asset: close).image(at: .zero).image
try check(wideFrame.dataProvider?.data != closeFrame.dataProvider?.data,
          "The selected camera lens did not reach the encoded frame.")

// A pure green logo in the bottom-right corner: green there, the plain frame elsewhere.
let logoFile = root.appendingPathComponent("Logo.png")
do {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let context = CGContext(data: nil, width: 64, height: 32, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.setFillColor(CGColor(srgbRed: 0, green: 1, blue: 0, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
  let destination = CGImageDestinationCreateWithURL(logoFile as CFURL, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  try check(CGImageDestinationFinalize(destination), "The logo fixture could not be written.")
}
func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (Int, Int, Int) {
  let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
  let offset = (y * image.width + x) * 4  // row 0 is the top
  return (Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2]))
}
let branded = try render("Logo", "keyframes", extra: ["--logo", logoFile.path, "--logo-corner", "br"])
let brandedFrame = try await AVAssetImageGenerator(asset: branded).image(at: .zero).image
// 320 × 180: the logo is 39.6 wide, 8 in from the right and bottom edges.
let (r, g, b) = pixel(brandedFrame, 320 - 8 - 20, 180 - 8 - 10)
try check(g > 180 && r < 90 && b < 90, "The logo did not reach the bottom-right corner (\(r), \(g), \(b)).")
let (r2, g2, b2) = pixel(brandedFrame, 20, 20)
try check(!(g2 > 180 && r2 < 90 && b2 < 90), "The logo appeared outside its corner.")
let missing = Process()
missing.executableURL = executable
missing.arguments = ["--render-editor-movie", input.path, "--out", root.appendingPathComponent("No Logo.mp4").path,
                     "--size", "320x180", "--fps", "24", "--source", "keyframes", "--logo", root.appendingPathComponent("gone.png").path]
missing.standardOutput = FileHandle.nullDevice
missing.standardError = FileHandle.nullDevice
try missing.run()
missing.waitUntilExit()
try check(missing.terminationStatus != 0, "A missing logo should stop the export rather than drop the logo.")

// The project's look reaches every source: a flat green scene without a floor fills the corners.
project["settings"] = ["video": ["studioLook": "chroma", "edgeLines": false]]
try writeProject()
for (name, source, extra) in [("Chroma Build", "build", [String]()), ("Chroma Keys", "keyframes", []),
                              ("Chroma Turntable", "turntable", ["--duration", "0.25"])] {
  let asset = try render(name, source, extra: extra)
  let frame = try await AVAssetImageGenerator(asset: asset).image(at: .zero).image
  for (x, y) in [(4, 4), (315, 4), (4, 175)] {
    let (r, g, b) = pixel(frame, x, y)
    try check(g > 140 && r < 60 && b < 110, "\(name): the scene backdrop did not reach the frame at \(x),\(y) (\(r), \(g), \(b)).")
  }
}

// A Build video follows the Camera track only when asked to (the web's exportCamera "track"):
// two tracks that differ only in their lens give different frames with the track, and the same
// frames without it.
project["settings"] = ["video": ["edgeLines": false]]
func cameraTrack(lensMm: Double) -> [String: Any] {
  let key: (String, Double) -> [String: Any] = { id, t in
    ["id": id, "t": t, "target": ["kind": "model"], "offset": [0, 0, 0], "azimuth": 30, "elevation": 25,
     "distance": ["fit": false, "value": 14], "roll": 0, "lensMm": lensMm, "focus": "target", "blur": 0, "origin": "user"]
  }
  return ["": ["build": ["keys": [key("a", 0), key("b", 1)],
                         "transitions": [["from": "a", "to": "b", "preset": "glide", "origin": "user",
                                          "settings": ["curve": ["kind": "easeInOut", "strength": 0.5], "path": "arc",
                                                       "orbit": "shortest", "extraTurns": 0, "overshoot": 0, "motionBlur": 0.5,
                                                       "shake": ["amount": 0, "frequency": 0.6], "cut": false,
                                                       "flowThrough": false]]],
                         "shutter": 0.5]]]
}
func firstFrame(_ name: String, lensMm: Double, track: Bool) async throws -> Data {
  var withTrack = project["plan"] as! [String: Any]
  withTrack["cameraTracks"] = cameraTrack(lensMm: lensMm)
  project["plan"] = withTrack
  try writeProject()
  let asset = try render(name, "build", extra: track ? ["--camera-track"] : [])
  let image = try await AVAssetImageGenerator(asset: asset).image(at: .zero).image
  return image.dataProvider!.data! as Data
}
let wideKeys = try await firstFrame("Track Wide", lensMm: 18, track: true)
let longKeys = try await firstFrame("Track Long", lensMm: 120, track: true)
try check(wideKeys != longKeys, "The Camera track did not film the Build video.")
let wideAuto = try await firstFrame("Auto Wide", lensMm: 18, track: false)
let longAuto = try await firstFrame("Auto Long", lensMm: 120, track: false)
try check(wideAuto == longAuto, "Without --camera-track the automatic camera should film the Build video.")
try check(wideAuto != wideKeys, "The automatic camera and the Camera track gave the same frame.")
