#pragma once
// What the rest of the program may know about the GPU without seeing a Metal type.

namespace bmr {

/// Whether drawing is possible here: a Metal device exists and every shader compiled.
bool gpuAvailable();
/// The shader compiler's message when it failed, otherwise "". Never null.
const char* shaderError();
/// The id<MTLDevice> every renderer draws with (for a CAMetalLayer), or null when gpuAvailable() is false.
void* gpuDevice();

}  // namespace bmr
