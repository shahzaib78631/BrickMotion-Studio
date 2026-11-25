#pragma once

#include <filesystem>
#include <functional>
#include "bmr/image.h"

namespace bmtools {

// Draws on a serial queue when the encoder has room. Throws on setup, drawing or encoding failure.
void encodeMovie(const std::filesystem::path& output, int width, int height, int fps, int frames,
                 const std::function<bmr::Image(int)>& draw, int bitRate = 0);

}  // namespace bmtools
