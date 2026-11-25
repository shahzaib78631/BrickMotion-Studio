#pragma once
#include <optional>
#include <string>
#include <vector>
#include "bmapp/movie_export.h"
#include "bmr/image.h"

namespace bmapp {

/// A logo rasterised once for one frame size: premultiplied RGBA with its opacity applied.
struct MovieLogo {
  int x = 0, y = 0, width = 0, height = 0;
  std::vector<uint8_t> rgba;
};

/// Where the web editor draws its logo: 22% of the short side wide, inset 48/1080 of it.
struct LogoRect { double x, y, width, height; };
LogoRect logoRect(int frameWidth, int frameHeight, int imageWidth, int imageHeight, LogoCorner corner);

/// Reads and rasterises the image file; nullopt with `error` set when it cannot be read.
std::optional<MovieLogo> loadMovieLogo(const std::string& file, int frameWidth, int frameHeight,
                                       LogoCorner corner, std::string& error);

/// Draws the logo over a frame of the size it was made for.
void composite(bmr::Image& frame, const MovieLogo& logo);

}  // namespace bmapp
