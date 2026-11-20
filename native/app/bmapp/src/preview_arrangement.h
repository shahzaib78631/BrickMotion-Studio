#pragma once

#include "bmapp/viewport.h"
#include "bmr/scene.h"

namespace bmapp {

std::vector<bmr::PiecePose> arrangement(const bm::Model& model, const bmr::Scene& geometry, int step, AssemblyPreview mode);

}  // namespace bmapp
