import CoreGraphics
import Foundation
import ImageIO
import QuickLookThumbnailing

@objc(BrickMotionThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
  override func provideThumbnail(for request: QLFileThumbnailRequest,
                                 _ handler: @escaping (QLThumbnailReply?, (any Error)?) -> Void) {
    guard let image = readImage(request.fileURL) else {
      handler(nil, NSError(domain: "BrickMotion.Thumbnail", code: 1))
      return
    }
    let size = request.maximumSize
    let factor = min(size.width / CGFloat(image.width), size.height / CGFloat(image.height))
    let fitted = CGSize(width: CGFloat(image.width) * factor, height: CGFloat(image.height) * factor)
    handler(QLThumbnailReply(contextSize: fitted) { context in
      context.interpolationQuality = .high
      context.draw(image, in: CGRect(origin: .zero, size: fitted))
      return true
    }, nil)
  }

  private func readImage(_ url: URL) -> CGImage? {
    let limit = 64 * 1024 * 1024
    guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= limit,
          let bytes = try? Data(contentsOf: url, options: .mappedIfSafe),
          let document = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          document["format"] as? String == "brickmotion-project",
          let thumbnail = document["brickmotionPreview"] as? [String: Any],
          thumbnail["version"] as? Int == 1,
          let png = thumbnail["png"] as? String, png.utf8.count <= 1024 * 1024,
          let data = Data(base64Encoded: png),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let w = info[kCGImagePropertyPixelWidth] as? Int, let h = info[kCGImagePropertyPixelHeight] as? Int,
          (1...1024).contains(w), (1...1024).contains(h) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }
}
