#pragma once
// Every number the renderer uses. Lengths are LDU unless a line says pixels.

namespace bmr {

/// Side, in pixels, of the blocks compare() looks at: about the size of a stud in a test frame,
/// so that one wrong stud is a whole block and is not averaged away over the image.
inline constexpr int kBlock = 16;

}  // namespace bmr
