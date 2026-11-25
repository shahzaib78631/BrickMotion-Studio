import AppKit
import ImageIO
import Observation
import UniformTypeIdentifiers

/// The logo drawn over exported videos. As in the web editor it belongs to the app, not to a
/// project. The chosen image is copied into Application Support, so moving or editing the
/// original never changes a video that is already queued.
@MainActor @Observable final class VideoLogo {
  enum Corner: String, CaseIterable, Identifiable {
    case topLeft = "tl", topRight = "tr", bottomLeft = "bl", bottomRight = "br"
    var id: Self { self }
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

  /// The arguments the movie helper takes, or none when no logo is shown.
  var options: [String] {
    guard enabled, let file else { return [] }
    return ["--logo", file.path, "--logo-corner", corner.rawValue]
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

    /// Draws the logo over a PNG in place, as the movie exporter does (bmapp/movie_logo.mm):
    /// 22% of the short side wide, inset 48/1080 of it, at 90% opacity.
    func apply(to png: URL) throws {
      func failure(_ text: String) -> NSError {
        NSError(domain: "BrickMotion.VideoLogo", code: 2, userInfo: [NSLocalizedDescriptionKey: text])
      }
      guard let source = CGImageSourceCreateWithURL(png as CFURL, nil),
            let picture = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw failure("The rendered still could not be read.") }
      guard let logoSource = CGImageSourceCreateWithURL(file as CFURL, nil),
            let logo = CGImageSourceCreateImageAtIndex(logoSource, 0, nil) else { throw failure("The logo could not be read.") }
      let width = picture.width, height = picture.height
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw failure("The still could not be drawn.") }
      context.draw(picture, in: CGRect(x: 0, y: 0, width: width, height: height))
      let unit = Double(min(width, height))
      let logoWidth = unit * 0.22, logoHeight = logoWidth * Double(logo.height) / Double(max(1, logo.width))
      let margin = 48 * unit / 1080
      let right = corner == .topRight || corner == .bottomRight
      let top = corner == .topLeft || corner == .topRight
      // CoreGraphics counts y from the bottom.
      let x = right ? Double(width) - margin - logoWidth : margin
      let y = top ? Double(height) - margin - logoHeight : margin
      context.interpolationQuality = .high
      context.setAlpha(0.9)
      context.draw(logo, in: CGRect(x: x.rounded(), y: y.rounded(), width: logoWidth.rounded(), height: logoHeight.rounded()))
      guard let stamped = context.makeImage(),
            let out = CGImageDestinationCreateWithURL(png as CFURL, "public.png" as CFString, 1, nil) else {
        throw failure("The still could not be written.")
      }
      CGImageDestinationAddImage(out, stamped, nil)
      guard CGImageDestinationFinalize(out) else { throw failure("The still could not be written.") }
    }
  }

  var stamp: Stamp? { enabled ? file.map { Stamp(file: $0, corner: corner) } : nil }
}
