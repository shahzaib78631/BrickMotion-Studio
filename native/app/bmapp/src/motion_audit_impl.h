#pragma once

#include "animation_keys.h"
#include "bmapp/motion_audit.h"
#include "session_impl.h"

namespace bmapp {

struct MotionAudit::Impl {
  std::shared_ptr<Session::Impl> backing;
  bm::Model model;
  bmr::Scene geometry;
  bm::plan::Timeline timeline;
  std::vector<int> owners;
  KeyScene scene;
  std::vector<KeyTrack> tracks;
  uint32_t target;
  double fps;
};

}  // namespace bmapp
