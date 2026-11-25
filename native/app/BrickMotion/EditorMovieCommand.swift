import BMApp
import Foundation

/// A subprocess entry point. The editor remains free while its own playback engine renders the movie.
enum EditorMovieCommand {
  static func start(_ args: [String]) -> Never {
    Task.detached { exit(await run(args)) }
    dispatchMain()
  }

  private static func run(_ args: [String]) async -> Int32 {
    guard let input = args.first else { return fail("No project was supplied.") }
    var spec = bmapp.MovieSettings()
    spec.snapRecordings = std.string(SoundSettingsSheet.recordings)
    var output: String?
    var audio = false
    var focus = bmapp.StringList()
    var arguments = args.dropFirst().makeIterator()
    while let option = arguments.next() {
      switch option {
      case "--snap-audio": audio = true
      case "--orthographic": spec.orthographic = true
      case "--standard-preview": spec.standardPreview = true
      case "--camera-track": spec.cameraTrack = true
      default:
        guard let value = arguments.next() else { return fail("Missing value for \(option).") }
        switch option {
        case "--out": output = value
        case "--size":
          let parts = value.split(separator: "x", omittingEmptySubsequences: false)
          guard parts.count == 2, let width = Int32(parts[0]), let height = Int32(parts[1]) else {
            return fail("The output size is invalid.")
          }
          spec.width = width
          spec.height = height
        case "--fps":
          guard let rate = Int32(value) else { return fail("The frame rate is invalid.") }
          spec.fps = rate
        case "--bitrate":
          guard let bits = Int32(value), bits >= 100_000, bits <= 240_000_000 else {
            return fail("The video bitrate is invalid.")
          }
          spec.bitRate = bits
        case "--model": focus.push_back(std.string(value))
        case "--logo": spec.logo = std.string(value)
        case "--logo-corner":
          switch value {
          case "tl": spec.logoCorner = .TopLeft
          case "tr": spec.logoCorner = .TopRight
          case "bl": spec.logoCorner = .BottomLeft
          case "br": spec.logoCorner = .BottomRight
          default: return fail("The logo corner is invalid.")
          }
        case "--scene-camera": spec.sceneCameraId = std.string(value)
        case "--source":
          switch value {
          case "build": spec.source = .Build
          case "keyframes": spec.source = .Keyframes
          case "turntable": spec.source = .Turntable
          default: return fail("The video source is invalid.")
          }
        case "--azimuth", "--elevation", "--fov":
          guard let angle = Double(value), angle.isFinite else { return fail("The camera is invalid.") }
          spec.viewportAngle = true
          if option == "--azimuth" { spec.yaw = angle * .pi / 180 }
          else if option == "--elevation" { spec.pitch = angle * .pi / 180 }
          else { spec.fieldOfView = angle * .pi / 180 }
        case "--duration":
          guard let seconds = Double(value) else { return fail("The turntable duration is invalid.") }
          spec.turntableSeconds = seconds
        default: return fail("Unknown movie option \(option).")
        }
      }
    }
    guard let output, !output.isEmpty else { return fail("No video destination was supplied.") }
    let session = bmapp.Session.create()!
    let opened = session.open(std.string(input))
    guard opened.ok else { return fail(String(opened.error)) }
    if !focus.isEmpty {
      let changed = session.focus(focus)
      guard changed.refused.empty(), session.focusPath().size() == focus.size() else {
        return fail("The selected submodel could not be opened.")
      }
    }
    guard let viewport = bmapp.Viewport.create(session) else { return fail("Metal could not start the video renderer.") }
    if !audio {
      let failure = String(viewport.exportMovie(spec, std.string(output)))
      return failure.isEmpty ? 0 : fail(failure)
    }
    guard spec.source == .Build, !spec.standardPreview, !session.buildSettings().standardPlanner else {
      return fail("Snap audio requires a native Build video.")
    }
    let destination = URL(fileURLWithPath: output)
    let temp = destination.deletingLastPathComponent().appendingPathComponent("Tracks-\(UUID())", isDirectory: true)
    let files = FileManager.default
    do {
      try files.createDirectory(at: temp, withIntermediateDirectories: false)
      defer { try? files.removeItem(at: temp) }
      let picture = temp.appendingPathComponent("Picture.mp4")
      let snaps = temp.appendingPathComponent("Snaps.wav")
      let compressed = temp.appendingPathComponent("Snaps.m4a")
      spec.snapWave = std.string(snaps.path)
      let failure = String(viewport.exportMovie(spec, std.string(picture.path)))
      guard failure.isEmpty else { return fail(failure) }
      try await MovieAudioMux.write(video: picture, snaps: snaps, compressed: compressed, to: destination)
      return 0
    } catch {
      return fail(error.localizedDescription)
    }
  }

  private static func fail(_ message: String) -> Int32 {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    return 1
  }
}
