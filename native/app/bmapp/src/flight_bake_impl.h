#pragma once

#include <mutex>

#include "animation_keys.h"
#include "bmapp/flight_bake.h"
#include "commands.h"

namespace bmapp {

struct FlightBake::Impl {
  struct Target {
    std::string id, previousId;
    bm::Vec3 pivot;
    int owner = -1;
  };

  uint64_t generation = 0, version = 0;
  bool replace = false;
  bool detach = false;
  std::string scope;
  KeyScene scene;
  double buildFPS = 24;
  bm::plan::Timeline timeline;
  std::vector<Target> targets;
  Command command;
  std::mutex mutex;
  std::optional<FlightBakeResult> result;
};

void prepareBakeEdit(FlightBake::Impl& bake, const Session::Impl& session, const PieceList& pieces);
Changed applyBakeEdit(Session::Impl& session, FlightBake::Impl& bake);

}  // namespace bmapp
