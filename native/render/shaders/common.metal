// Shared by every shader. All of native/render/shaders is compiled as one text, this file first.
//
// Conventions:
// - World space is the model's (LDU, -y up) less the scene's origin, so numbers stay small.
// - Depth is reversed: the near plane is depth 1 and the far plane 0, cleared to 0, tested
//   greater-or-equal. That keeps depth precision far from the eye, which large models need.
// - Colour is linear until the last pass, which applies the tone curve and writes sRGB.
#include <metal_stdlib>
using namespace metal;
