#pragma once
// A picture as the tools and tests handle it, and how two pictures differ.
#include <cstdint>
#include <filesystem>
#include <vector>

namespace bmr {

/// 8 bits a channel, red green blue alpha, row 0 at the top, sRGB, alpha not multiplied in.
struct Image {
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;  ///< width * height * 4
  bool empty() const { return width <= 0 || height <= 0 || rgba.size() != static_cast<size_t>(width) * static_cast<size_t>(height) * 4; }
  /// The four channels of a pixel, or nullptr outside the image.
  const uint8_t* at(int x, int y) const {
    if (empty() || x < 0 || y < 0 || x >= width || y >= height) return nullptr;
    return rgba.data() + (static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)) * 4;
  }
};

/// False if the image is empty or the file cannot be written. Never throws.
bool writePng(const Image& image, const std::filesystem::path& file);
/// An empty image if the file is missing or is not a picture. Never throws.
Image readPng(const std::filesystem::path& file);

struct Difference {
  double meanAbs = 0;     ///< mean absolute difference per channel, 0..255
  double worstBlock = 0;  ///< the largest such mean over any kBlock x kBlock block
  bool sameSize = true;   ///< false: the two cannot be compared and the other fields are 0
};
/// How far apart two pictures are. Blocks are laid from the top left; a block cut by the
/// right or bottom edge counts the pixels it has. Two empty images are the same.
Difference compare(const Image& a, const Image& b);

}  // namespace bmr
