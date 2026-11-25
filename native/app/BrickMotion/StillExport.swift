import AppKit
import BMApp
import UniformTypeIdentifiers

@MainActor enum StillExport {
  @discardableResult static func copyViewport(_ view: ViewportView, to board: NSPasteboard = .general) -> Bool {
    let picture = view.viewport.capture()
    view.changed()
    guard let image = picture.cgImage, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
      NSSound.beep()
      return false
    }
    board.clearContents()
    return board.setData(png, forType: .png)
  }

}

extension bmapp.Picture {
  var cgImage: CGImage? {
    let w = Int(width), h = Int(height)
    guard w > 0, h > 0, rgba.size() == w * h * 4,
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var data = Data(count: w * h * 4)
    let copied = data.withUnsafeMutableBytes {
      copyRGBA($0.bindMemory(to: UInt8.self).baseAddress, $0.count)
    }
    guard copied, let provider = CGDataProvider(data: data as CFData) else { return nil }
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                   space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }
}
