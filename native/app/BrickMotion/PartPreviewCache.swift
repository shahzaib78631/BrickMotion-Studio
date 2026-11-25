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
  private var inFlight: [Request: Task<CGImage?, Never>] = [:]

  init() {
    images.totalCostLimit = 64 * 1024 * 1024
  }

  func image(for request: Request) async -> CGImage? {
    guard !Task.isCancelled else { return nil }
    let key = cacheKey(for: request)
    if let image = images.object(forKey: key) { return image }
    if let task = inFlight[request] { return await task.value }
    let task = Task<CGImage?, Never> {
      self.renderAndStore(request)
    }
    inFlight[request] = task
    let result = await task.value
    inFlight[request] = nil
    return result
  }

  func prewarm(parts: [String], color: Int32 = 71, dark: Bool) async {
    for part in parts {
      guard !Task.isCancelled else { return }
      let request = Request(part: part, color: color, dark: dark)
      if images.object(forKey: cacheKey(for: request)) != nil { continue }
      _ = await image(for: request)
    }
  }

  private func cacheKey(for request: Request) -> NSString {
    "\(request.part)/\(request.color)/\(request.dark)" as NSString
  }

  private func renderAndStore(_ request: Request) -> CGImage? {
    let key = cacheKey(for: request)
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
