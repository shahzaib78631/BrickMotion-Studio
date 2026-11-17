#pragma once
// Every number the renderer uses. Lengths are LDU unless a line says pixels.

namespace bmr {

/// Side, in pixels, of the blocks compare() looks at: about the size of a stud in a test frame,
/// so that one wrong stud is a whole block and is not averaged away over the image.
inline constexpr int kBlock = 16;

/// Faces that meet at less than this angle are shaded as one curved surface; a sharper turn
/// is an edge. LDraw's curved primitives turn 22.5 degrees a facet at 16 sides and real edges
/// 90: 35 smooths a 16-sided cylinder and keeps every true edge. An 8-sided low-detail
/// cylinder (45 a facet) is therefore faceted, which is right at the size it is shown.
inline constexpr double kCreaseDegrees = 35.0;

/// The colour of a triangle whose colour code is not in the table: mid grey, as bm::ldraw::Color's default.
inline constexpr unsigned kUnknownColor = 0xFF888888u;

}  // namespace bmr
