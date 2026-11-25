#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>

#include "movie_logo.h"

#include <algorithm>
#include <cmath>

namespace bmapp {
namespace {
constexpr double kLogoWidth = 0.22, kLogoMargin = 48, kLogoAlpha = 0.9;  // exportVideo.ts
}

LogoRect logoRect(int frameWidth, int frameHeight, int imageWidth, int imageHeight, LogoCorner corner) {
  const double unit = std::min(frameWidth, frameHeight);
  const double width = unit * kLogoWidth;
  const double height = width * imageHeight / std::max(1, imageWidth);
  const double margin = kLogoMargin * unit / 1080;
  const bool right = corner == LogoCorner::TopRight || corner == LogoCorner::BottomRight;
  const bool top = corner == LogoCorner::TopLeft || corner == LogoCorner::TopRight;
  return {right ? frameWidth - margin - width : margin, top ? margin : frameHeight - margin - height, width, height};
}

std::optional<MovieLogo> loadMovieLogo(const std::string& file, int frameWidth, int frameHeight,
                                       LogoCorner corner, std::string& error) {
  @autoreleasepool {
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:file.c_str()]];
    CGImageSourceRef source = url ? CGImageSourceCreateWithURL((__bridge CFURLRef)url, nullptr) : nullptr;
    CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, nullptr) : nullptr;
    if (source) CFRelease(source);
    if (!image) {
      error = "The video logo could not be read.";
      return std::nullopt;
    }
    const auto rect = logoRect(frameWidth, frameHeight, static_cast<int>(CGImageGetWidth(image)),
                               static_cast<int>(CGImageGetHeight(image)), corner);
    MovieLogo logo;
    // Whole pixels: the logo's own edges are antialiased by the scaling, not by the placement.
    logo.x = static_cast<int>(std::lround(rect.x));
    logo.y = static_cast<int>(std::lround(rect.y));
    logo.width = std::clamp(static_cast<int>(std::lround(rect.width)), 1, frameWidth);
    logo.height = std::clamp(static_cast<int>(std::lround(rect.height)), 1, frameHeight);
    logo.rgba.assign(static_cast<size_t>(logo.width) * logo.height * 4, 0);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(logo.rgba.data(), logo.width, logo.height, 8, logo.width * 4ul, space,
                                                 static_cast<uint32_t>(kCGImageAlphaPremultipliedLast) | static_cast<uint32_t>(kCGBitmapByteOrder32Big));
    CGColorSpaceRelease(space);
    if (!context) {
      CGImageRelease(image);
      error = "The video logo could not be drawn.";
      return std::nullopt;
    }
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextSetAlpha(context, kLogoAlpha);
    CGContextDrawImage(context, CGRectMake(0, 0, logo.width, logo.height), image);
    CGContextRelease(context);
    CGImageRelease(image);
    return logo;
  }
}

void composite(bmr::Image& frame, const MovieLogo& logo) {
  if (frame.empty() || logo.rgba.size() != static_cast<size_t>(logo.width) * logo.height * 4) return;
  // A bitmap context's first row in memory is the image's top, as the frame's is.
  for (int row = 0; row < logo.height; ++row) {
    const int y = logo.y + row;
    if (y < 0 || y >= frame.height) continue;
    for (int column = 0; column < logo.width; ++column) {
      const int x = logo.x + column;
      if (x < 0 || x >= frame.width) continue;
      const uint8_t* src = logo.rgba.data() + (static_cast<size_t>(row) * logo.width + column) * 4;
      if (src[3] == 0) continue;
      uint8_t* dst = frame.rgba.data() + (static_cast<size_t>(y) * frame.width + x) * 4;
      const int keep = 255 - src[3];
      for (int c = 0; c < 3; ++c) dst[c] = static_cast<uint8_t>(std::min(255, src[c] + (dst[c] * keep + 127) / 255));
      dst[3] = static_cast<uint8_t>(std::min(255, src[3] + (dst[3] * keep + 127) / 255));
    }
  }
}

}  // namespace bmapp
