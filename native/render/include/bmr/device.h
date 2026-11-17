#pragma once
// What the rest of the program may know about the GPU without seeing a Metal type.

namespace bmr {

/// Whether drawing is possible here: a Metal device exists and every shader compiled.
bool gpuAvailable();
/// The shader compiler's message when it failed, otherwise "". Never null.
const char* shaderError();

}  // namespace bmr
