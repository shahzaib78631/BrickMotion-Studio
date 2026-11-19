#pragma once
// What the keyboard's editing keys mean in the model.
#include "bmapp/types.h"
#include "bmapp/viewport.h"

namespace bmapp {

/// The model axis an arrow key moves along for this camera: the world x or z axis whose screen
/// direction is nearest the arrow's (ties go to x), signed. Up and down follow the camera's
/// forward on the floor: up moves away from the eye.
Vec3 arrowAxis(const CameraState& camera, Arrow arrow);

inline constexpr double kStud = 20, kPlate = 8, kBrick = 24;  ///< LDU

}  // namespace bmapp
