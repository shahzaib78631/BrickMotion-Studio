import AppKit
import BMApp
import Observation
import UniformTypeIdentifiers

/// The logo drawn over exported videos. As in the web editor it belongs to the app, not to a
/// project. The chosen image is copied into Application Support, so moving or editing the
/// original never changes a video that is already queued.
@MainActor @Observable final class VideoLogo {
  enum Corner: String, CaseIterable, Identifiable {
    case topLeft = "tl", topRight = "tr", bottomLeft = "bl", bottomRight = "br"
    var id: Self { self }
    var engine: bmapp.LogoCorner {
      switch self {
      case .topLeft: .TopLeft
      case .topRight: .TopRight
      case .bottomLeft: .BottomLeft
      case .bottomRight: .BottomRight
      }
    }
    var title: String {
      switch self {
      case .topLeft: "Top Left"
      case .topRight: "Top Right"
      case .bottomLeft: "Bottom Left"
      case .bottomRight: "Bottom Right"
      }
    }
  }

  static let shared = VideoLogo()
  static let types: [UTType] = [.png, .jpeg, .heic, .tiff, .webP]  // what ImageIO decodes for the exporter

  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let folder: URL
  private(set) var file: URL?
  private(set) var preview: NSImage?
  var enabled: Bool { didSet { defaults.set(enabled, forKey: "videoLogoEnabled") } }
  var corner: Corner { didSet { defaults.set(corner.rawValue, forKey: "videoLogoCorner") } }

  init(defaults: UserDefaults = .standard, folder: URL? = nil) {
    self.defaults = defaults
    let logos = folder ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("BrickMotion/Video Logos", isDirectory: true)
    self.folder = logos
    corner = defaults.string(forKey: "videoLogoCorner").flatMap(Corner.init(rawValue:)) ?? .bottomRight
    let name = defaults.string(forKey: "videoLogoFile")
    let saved = name.map { logos.appendingPathComponent($0) }
    if let saved, let image = NSImage(contentsOf: saved) {
      file = saved
      preview = image
      enabled = defaults.object(forKey: "videoLogoEnabled") as? Bool ?? true
    } else {
      enabled = false
    }
  }

  func choose(_ source: URL) throws {
    guard let image = NSImage(contentsOf: source), image.isValid else {
      throw NSError(domain: "BrickMotion.VideoLogo", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "The image could not be read. Choose a PNG, JPEG, HEIC or TIFF file."
      ])
    }
    let files = FileManager.default
    try files.createDirectory(at: folder, withIntermediateDirectories: true)
    // A new name each time: a queued export keeps reading the logo it was submitted with.
    let copy = folder.appendingPathComponent("Logo-\(UUID().uuidString)")
      .appendingPathExtension(source.pathExtension.isEmpty ? "png" : source.pathExtension.lowercased())
    try files.copyItem(at: source, to: copy)
    file = copy
    preview = image
    enabled = true
    defaults.set(copy.lastPathComponent, forKey: "videoLogoFile")
  }

  func remove() {
    file = nil
    preview = nil
    enabled = false
    defaults.removeObject(forKey: "videoLogoFile")
  }
}

extension VideoLogo {
  /// What a render job needs to draw the logo later, off the main actor.
  struct Stamp: Sendable {
    let file: URL
    let corner: Corner

    /// Draws the logo over a PNG in place, as the movie exporter does (bmapp's stampLogo).
    func apply(to png: URL) throws {
      let failure = String(bmapp.stampLogo(std.string(png.path), std.string(file.path), corner.engine))
      guard failure.isEmpty else {
        throw NSError(domain: "BrickMotion.VideoLogo", code: 2, userInfo: [NSLocalizedDescriptionKey: failure])
      }
    }
  }

  var stamp: Stamp? { enabled ? file.map { Stamp(file: $0, corner: corner) } : nil }
}
