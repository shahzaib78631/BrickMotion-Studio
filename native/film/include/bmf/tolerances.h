#pragma once
// Every number the camera uses, with why it has its value. LDU, radians, seconds unless named.

namespace bm::film {

/// The lens and sensor a shot has when nothing says otherwise: a normal lens on full frame. The
/// sensor number is the frame's height, as the web app's fovForLens takes it, so saved tracks
/// film the same.
inline constexpr double kLensMm = 50;
inline constexpr double kSensorMm = 36;
/// The share of each half of the frame a subject may use: a tenth is left to the edge, as a
/// broadcast safe frame.
inline constexpr double kSafeFrame = 0.9;
/// How much of the safe frame a subject fills, by shot size: wide, medium, close.
inline constexpr double kFill[3] = {0.85, 0.6, 0.35};
/// Lead room: a followed subject sits this far (normalised screen units) behind the centre, so
/// the frame has room ahead of it.
inline constexpr double kLeadShare = 0.12;
/// The nearest the eye comes to what it looks at.
inline constexpr double kMinDistance = 10;

}  // namespace bm::film

namespace bm::film {

/// How much a flight matters to the camera, 0..1: the sum of these, as they apply.
inline constexpr double kImportanceSize = 0.5;        ///< times the unit's share of the model's volume
inline constexpr double kImportanceUnit = 0.3;        ///< it brings a unit built on its own spot
inline constexpr double kImportanceFirst = 0.15;      ///< the first of its step
inline constexpr double kImportanceSilhouette = 0.4;  ///< it makes the model taller or wider...
inline constexpr double kSilhouetteGrow = 0.08;       ///< ...by more than this share of it

}  // namespace bm::film
