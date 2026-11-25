// The video logo: the web editor's placement, and an exact blend over the frame.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include "../src/movie_logo.h"

namespace {
// A 40 × 20 logo: an opaque red left half, a transparent right half.
std::filesystem::path writeLogo() {
  const auto path = std::filesystem::temp_directory_path() / "bmapp-logo-test.png";
  std::vector<uint8_t> pixels(40 * 20 * 4, 0);
  for (int y = 0; y < 20; ++y)
    for (int x = 0; x < 20; ++x) {
      auto* p = pixels.data() + (y * 40 + x) * 4;
      p[0] = 255, p[3] = 255;
    }
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(pixels.data(), 40, 20, 8, 160, space,
                                               static_cast<uint32_t>(kCGImageAlphaPremultipliedLast) | static_cast<uint32_t>(kCGBitmapByteOrder32Big));
  CGImageRef image = CGBitmapContextCreateImage(context);
  NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
  CGImageDestinationRef out = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, nullptr);
  CGImageDestinationAddImage(out, image, nullptr);
  CGImageDestinationFinalize(out);
  CFRelease(out);
  CGImageRelease(image);
  CGContextRelease(context);
  CGColorSpaceRelease(space);
  return path;
}
}  // namespace

TEST_CASE("the video logo sits where the web editor draws it", "[bmapp][movie]") {
  const auto r = bmapp::logoRect(1920, 1080, 400, 200, bmapp::LogoCorner::BottomRight);
  CHECK(r.width == Catch::Approx(1080 * 0.22));
  CHECK(r.height == Catch::Approx(1080 * 0.11));
  CHECK(r.x == Catch::Approx(1920 - 48 - r.width));
  CHECK(r.y == Catch::Approx(1080 - 48 - r.height));
  const auto t = bmapp::logoRect(1080, 1920, 400, 200, bmapp::LogoCorner::TopLeft);
  CHECK(t.x == Catch::Approx(48));
  CHECK(t.y == Catch::Approx(48));
}

TEST_CASE("the video logo blends at 90% over the frame and nowhere else", "[bmapp][movie]") {
  const auto file = writeLogo();
  std::string error;
  const auto logo = bmapp::loadMovieLogo(file.string(), 1080, 1080, bmapp::LogoCorner::TopLeft, error);
  REQUIRE(logo);
  CHECK(error.empty());
  CHECK(logo->x == 48);
  CHECK(logo->y == 48);
  CHECK(logo->width == 238);
  CHECK(logo->height == 119);
  bmr::Image frame;
  frame.width = frame.height = 1080;
  frame.rgba.assign(1080 * 1080 * 4, 0);
  for (size_t i = 3; i < frame.rgba.size(); i += 4) frame.rgba[i] = 255;  // opaque black
  bmapp::composite(frame, *logo);
  const auto* red = frame.at(48 + 40, 48 + 60);     // inside the opaque half
  CHECK(int(red[0]) >= 228);                         // 255 × 0.9
  CHECK(int(red[0]) <= 231);
  CHECK(int(red[1]) == 0);
  CHECK(int(red[3]) == 255);
  const auto* clear = frame.at(48 + 200, 48 + 60);  // the transparent half
  CHECK(int(clear[0]) == 0);
  CHECK(int(frame.at(20, 20)[0]) == 0);              // outside the logo
  std::filesystem::remove(file);
  CHECK_FALSE(bmapp::loadMovieLogo((file.string() + ".missing"), 1080, 1080, bmapp::LogoCorner::TopLeft, error));
  CHECK_FALSE(error.empty());
}
