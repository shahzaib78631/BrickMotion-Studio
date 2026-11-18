#pragma once
// Denoising a path-traced picture with Intel Open Image Denoise (vendor/oidn), guided by its
// albedo and normal.
#include <string>
#include "bmr/path_tracer.h"

namespace bmr {

enum class DenoiseDevice { Cpu, Metal };

/// False when this build has no OIDN (it was not in vendor/oidn when configured).
bool denoiserAvailable();

/// Replaces `image.beauty` with OIDN's RT filter of it (HDR, with albedo and normal). The CPU
/// device gives the same result every run; the Metal device is faster but not promised to.
/// False, with `error` set if given, when the image is empty, OIDN is absent, or it fails;
/// the image is then unchanged. Never throws.
bool denoise(PathImage& image, DenoiseDevice device, std::string* error);

}  // namespace bmr
