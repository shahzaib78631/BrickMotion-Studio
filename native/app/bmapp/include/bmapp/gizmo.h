#pragma once
// The move and rotate gizmos: their shape on screen, which handle a point is on, and what a drag
// on a handle means in the model. Points are from the top left of the view.
#include <vector>
#include "bmapp/types.h"
#include "bmapp/viewport.h"

namespace bmapp {

enum class GizmoKind { None, Move, Rotate };
/// Axes and planes for Move; axis rings and View (the screen ring) for Rotate.
enum class Handle { None, X, Y, Z, XY, YZ, XZ, View };

struct GizmoSeg {
  Vec2 a, b;
  Handle h = Handle::None;
};
struct GizmoShape {
  std::vector<GizmoSeg> lines;              ///< Move's axes
  std::vector<std::vector<Vec2>> rings;     ///< closed outlines: Move's plane squares, Rotate's rings
  std::vector<Handle> ringHandles;          ///< one per ring
};

/// How long an axis is drawn, in points, whatever the distance.
inline constexpr double kGizmoPoints = 84;

/// Where a model point shows; (nan, nan) when it is behind the eye.
Vec2 projectPoint(const CameraState& camera, Vec2 viewportPoints, Vec3 p);
/// `axes`: identity for world axes, or the first selected piece's rotation for its own.
GizmoShape gizmoShape(const CameraState& camera, Vec2 viewportPoints, Vec3 origin, Mat3 axes, GizmoKind kind);
/// The handle nearest `point` within `tolerancePoints`; a point inside a plane square is on it.
Handle hitGizmo(const GizmoShape& shape, Vec2 point, double tolerancePoints = 6);
/// The model axis a handle stands for (unit): an axis of `axes`, or toward the eye for View;
/// zero for planes and None.
Vec3 handleAxis(const CameraState& camera, Mat3 axes, Handle handle);
/// Movement for a drag from a to b on `handle`: along the axis or in the plane, in LDU, snapped
/// on each of `axes` to `snap` (0: free). A handle seen edge-on moves nothing.
Vec3 dragMove(const CameraState& camera, Vec2 viewportPoints, Vec3 origin, Mat3 axes, Handle handle, Vec2 a, Vec2 b, Vec3 snap);
/// The angle of a rotate drag about the handle's axis, right-handed, in degrees: snapped to 15
/// unless `free`.
double dragRotate(const CameraState& camera, Vec2 viewportPoints, Vec3 origin, Mat3 axes, Handle handle, Vec2 a, Vec2 b, bool free);

}  // namespace bmapp
