#pragma once
// Every number the stability check uses.

namespace bm::stable {

/// ABS, grams per cubic LDU: 1.05 g/cm3, and an LDU is 0.4 mm.
inline constexpr double kDensity = 1.05 * 0.04 * 0.04 * 0.04;

/// A part whose mesh does not enclose a volume (open, or wound inconsistently) is weighed as
/// this share of its bounding box: a brick's walls and tubes fill about a quarter of it.
inline constexpr double kHollowShare = 0.25;

/// An enclosed volume under this share of the part's box, or over all of it, is not believed.
inline constexpr double kMinFill = 0.02;

/// Points within this of the lowest point of the model (LDU, along `down`) stand on the floor.
inline constexpr double kFloorSlack = 1.0;

}  // namespace bm::stable
