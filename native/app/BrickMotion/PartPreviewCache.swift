import BMApp
import CoreGraphics
import Foundation

actor PartPreviewCache {
  static let shared = PartPreviewCache()

  struct Request: Hashable, Sendable {
    let part: String
    let color: Int32
    let dark: Bool
  }

  private let images = NSCache<NSString, CGImage>()
  private var renderer: bmapp.PartPreview?

  init() {
    images.totalCostLimit = 12 * 1024 * 1024
  }

  func image(for request: Request) -> CGImage? {
    guard !Task.isCancelled else { return nil }
    let key = "\(request.part)/\(request.color)/\(request.dark)" as NSString
    if let image = images.object(forKey: key) { return image }
    if renderer == nil {
      let directory = bmapp.Session.ldrawDirectory()
      guard !directory.empty() else { return nil }
      renderer = bmapp.PartPreview.create(directory)
    }
    guard let renderer else { return nil }
    guard let image = CGImage.make(from: renderer.render(std.string(request.part), request.color, request.dark)) else { return nil }
    images.setObject(image, forKey: key, cost: image.bytesPerRow * image.height)
    return image
  }
}
