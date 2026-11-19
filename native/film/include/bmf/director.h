#pragma once
// The director: a build's beats into a shot list, as an editor would cut it, in a style.
#include <vector>
#include "bm/collide/world.h"
#include "bmf/beats.h"
#include "bmf/rules.h"
#include "bmf/shots.h"

namespace bm::film {

struct DirectorStyle {
  double elStart = 0, elEnd = 0, finishEl = 0;  ///< radians
  double cutAt = 0.8;           ///< the share of the build after which it cuts to the front
  double insertThreshold = 0.6;  ///< beats more important than this get a close shot
  double lensMm = 50;
};
/// The web's "reference" rules (BrickHeadz speed builds): high over the base, lower as it grows,
/// a cut to a low front view for the last details.
DirectorStyle referenceStyle();

/// `front`: the model's front azimuth (radians; 0 is LDraw's).
std::vector<Shot> direct(const Beats& beats, const plan::Timeline& timeline, const plan::Plan& plan, const collide::World& world, const DirectorStyle& style, double fps,
                         double front = 0);

}  // namespace bm::film
