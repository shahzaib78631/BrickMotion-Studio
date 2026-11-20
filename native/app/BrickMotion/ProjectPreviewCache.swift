import BMApp
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

actor ProjectPreviewCache {
  static let shared = ProjectPreviewCache()

  private let images = NSCache<NSString, CGImage>()
  private var renderer: bmapp.PartPreview?

  init() { images.countLimit = 24 }

  func image(for url: URL, dark: Bool) -> CGImage? {
    guard !Task.isCancelled,
          let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]) else { return nil }
    let modified = values.contentModificationDate?.timeIntervalSinceReferenceDate ?? 0
    let key = "\(url.path)|\(values.fileSize ?? 0)|\(modified)|\(dark)" as NSString
    if let image = images.object(forKey: key) { return image }
    guard let image = render(url, dark: dark) else { return nil }
    images.setObject(image, forKey: key)
    return image
  }

  private func render(_ url: URL, dark: Bool) -> CGImage? {
    if renderer == nil {
      let directory = bmapp.Session.ldrawDirectory()
      guard !directory.empty() else { return nil }
      renderer = bmapp.PartPreview.create(directory)
    }
    guard let renderer else { return nil }
    return CGImage.make(from: renderer.renderModel(std.string(url.path), dark))
  }

  func thumbnailPNG(for project: Data) -> Data? {
    guard !Task.isCancelled else { return nil }
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("BMPreview-\(UUID().uuidString).brickmotion")
    defer { try? FileManager.default.removeItem(at: path) }
    guard (try? project.write(to: path, options: .atomic)) != nil,
          let image = render(path, dark: false) else { return nil }
    let bytes = NSMutableData()
    guard let encoder = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(encoder, image, nil)
    guard CGImageDestinationFinalize(encoder), bytes.length < 700_000 else { return nil }
    return bytes as Data
  }
}
