// PNG files through ImageIO. Pixels go in and come out with alpha not multiplied in: a
// bitmap context would multiply it, so the image is built from, and read as, raw data.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#include "bmr/image.h"

namespace bmr {

bool writePng(const Image& image, const std::filesystem::path& file) {
  if (image.empty()) return false;
  @autoreleasepool {
    NSData* data = [NSData dataWithBytes:image.rgba.data() length:image.rgba.size()];
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef cg = CGImageCreate(static_cast<size_t>(image.width), static_cast<size_t>(image.height), 8, 32, static_cast<size_t>(image.width) * 4, space,
                                  static_cast<CGBitmapInfo>(kCGImageAlphaLast) | kCGBitmapByteOrderDefault, provider, nullptr, false, kCGRenderingIntentDefault);
    bool ok = false;
    if (cg) {
      NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:file.c_str()]];
      CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, nullptr);
      if (dest) {
        CGImageDestinationAddImage(dest, cg, nullptr);
        ok = CGImageDestinationFinalize(dest);
        CFRelease(dest);
      }
      CGImageRelease(cg);
    }
    CGColorSpaceRelease(space);
    CGDataProviderRelease(provider);
    return ok;
  }
}

Image readPng(const std::filesystem::path& file) {
  Image out;
  @autoreleasepool {
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:file.c_str()]];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, nullptr);
    if (!source) return out;
    CGImageRef cg = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
    CFRelease(source);
    if (!cg) return out;
    const size_t w = CGImageGetWidth(cg), h = CGImageGetHeight(cg), bpp = CGImageGetBitsPerPixel(cg), row = CGImageGetBytesPerRow(cg);
    const CGImageAlphaInfo alpha = CGImageGetAlphaInfo(cg);
    CFDataRef raw = CGDataProviderCopyData(CGImageGetDataProvider(cg));
    // Only what writePng makes and plain opaque PNGs: 8 bits a channel, red first.
    const bool four = bpp == 32, three = bpp == 24;
    if (raw && w > 0 && h > 0 && CGImageGetBitsPerComponent(cg) == 8 && (four || three) && static_cast<size_t>(CFDataGetLength(raw)) >= row * (h - 1) + w * (bpp / 8)) {
      const uint8_t* bytes = CFDataGetBytePtr(raw);
      out.width = static_cast<int>(w), out.height = static_cast<int>(h);
      out.rgba.resize(w * h * 4);
      const bool premultiplied = alpha == kCGImageAlphaPremultipliedLast;
      const bool hasAlpha = four && (alpha == kCGImageAlphaLast || premultiplied);
      for (size_t y = 0; y < h; y++)
        for (size_t x = 0; x < w; x++) {
          const uint8_t* p = bytes + y * row + x * (bpp / 8);
          uint8_t* q = out.rgba.data() + (y * w + x) * 4;
          const uint8_t a = hasAlpha ? p[3] : 255;
          for (int c = 0; c < 3; c++) q[c] = premultiplied && a > 0 && a < 255 ? static_cast<uint8_t>(std::min(255, (p[c] * 255 + a / 2) / a)) : p[c];
          q[3] = a;
        }
    }
    if (raw) CFRelease(raw);
    CGImageRelease(cg);
  }
  return out;
}

}  // namespace bmr
