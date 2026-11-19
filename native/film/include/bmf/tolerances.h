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

namespace bm::film {

// Editing. Common practice for edited film: a shot a viewer can take in, cuts no faster than
// they can follow, and no cut to nearly the same picture.
inline constexpr double kMinShotSeconds = 1.5;
inline constexpr double kCutWindowSeconds = 20;  ///< cuts are counted over any window this long...
inline constexpr int kCutsPerWindow = 5;         ///< ...and are at most this many: one in 4 s
inline constexpr double kJumpCutRadians = 0.5236;  ///< 30 degrees: a cut turns at least this much, or changes size

// The director.
inline constexpr double kAnticipateSeconds = 0.6;  ///< a move to the next scene is done this long before its first piece leaves
inline constexpr double kBlendSeconds = 1.0;       ///< how long a move from one scene's angle to the next takes
/// A scene (one camera angle) lasts at least this long; at most kCutsPerWindow of them in a
/// window, as cuts.
inline constexpr double kMinSceneSeconds = 4.0;
/// Steps whose pieces land within this angle round the model, seen from above, are one scene.
inline constexpr double kSceneSpread = 1.5708;
inline constexpr int kCoverageAzimuths = 16;  ///< angles round the model tried for a scene
inline constexpr int kVisibilityPoints = 24;  ///< seats per scene looked for from each
/// A scene's angle: the share of its seat points in view, plus kSidePull for facing the side
/// its pieces land on, less kStayPull for turning away from the angle before.
inline constexpr double kSidePull = 0.3;
inline constexpr double kStayPull = 0.1;
/// Seats this close to the model's middle (a share of its radius), seen from above, are on no side.
inline constexpr double kNoSide = 0.1;
/// A neighbour's box is shrunk by this much before it is said to hide a seat point: touching
/// pieces do not hide each other's corners.
inline constexpr double kOcclusionInset = 1.0;
inline constexpr double kInsertSeconds = 1.6;   ///< a close shot of a landing: this long, ending...
inline constexpr double kInsertAfter = 0.3;     ///< ...this long after it lands
inline constexpr double kInsertTurn = 0.6109;   ///< 35 degrees from the main angle, so it is no jump cut
inline constexpr double kRevealArc = 0.6;       ///< the finish arcs this far round onto the front

}  // namespace bm::film

namespace bm::film {

// The camera body.
inline constexpr double kEyeClearance = 8;   ///< the eye keeps this far from anything built, and above the floor
inline constexpr double kSmoothSeconds = 0.5;  ///< the window rig values are averaged over (twice, centred: no lag)
inline constexpr double kAvoidStep = 0.05;   ///< radians: how far the eye swings at a time to get clear
inline constexpr int kAvoidSteps = 32;       ///< how many such swings it tries each way
inline constexpr double kFocusAperture = 0;  ///< no depth of field yet: stored for the path tracer
inline constexpr double kShutter = 0.5;      ///< a 180-degree shutter, stored for the path tracer

}  // namespace bm::film
