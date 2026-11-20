import BMApp
import CoreGraphics
import Foundation

extension CGImage {
  static func make(from picture: bmapp.Picture) -> CGImage? {
    let width = Int(picture.width), height = Int(picture.height)
    guard width > 0, height > 0, picture.rgba.size() == width * height * 4 else { return nil }
    let pixels = Data(picture.rgba)
    guard let provider = CGDataProvider(data: pixels as CFData),
          let rgb = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: width * 4, space: rgb,
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }
}
