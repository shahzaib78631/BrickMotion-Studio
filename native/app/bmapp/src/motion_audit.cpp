#include "motion_audit_impl.h"

#include <set>
#include "bm/collide/pair.h"
#include "engine.h"

namespace bmapp {
namespace {
bool meets(const bm::Box& a, const bm::Box& b) {
  return a.min.x <= b.max.x && b.min.x <= a.max.x &&
         a.min.y <= b.max.y && b.min.y <= a.max.y &&
         a.min.z <= b.max.z && b.min.z <= a.max.z;
}
}  // namespace

MotionAudit::MotionAudit(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
MotionAudit::~MotionAudit() = default;

MotionAuditResult MotionAudit::check() {
  MotionAuditResult out;
  try {
    const Impl& clip = *impl_;
    const auto& pieces = clip.model.pieces();
    if (clip.target >= pieces.size()) return out;
    const size_t n = pieces.size();
    const int stride = std::max(1, (clip.scene.last - clip.scene.first + 599) / 600);
    out.stride = stride;
    std::set<int> frames{clip.scene.first, clip.scene.last};
    for (int frame = clip.scene.first; frame <= clip.scene.last; frame += stride) frames.insert(frame);
    for (const auto& track : clip.tracks)
      if (std::find(track.members.begin(), track.members.end(), clip.target) != track.members.end())
        for (const auto& key : track.keys) frames.insert(key.frame);

    bm::collide::ShapeCache shapes;
    bmtools::ConnectorSources connectors(*clip.backing->library, clip.backing->ldraw);
    std::vector<bm::Box> bounds(n);
    std::vector<std::shared_ptr<const bm::collide::Shape>> shape(n);
    std::vector<std::shared_ptr<const std::vector<bm::connect::Connector>>> devices(n);
    for (size_t i = 0; i < n && i < clip.geometry.where.size(); ++i) {
      const auto group = clip.geometry.where[i].first;
      if (group < clip.geometry.groups.size()) bounds[i] = clip.geometry.groups[group].partBox;
    }
    const auto shapeOf = [&](uint32_t i) {
      if (!shape[i]) shape[i] = shapes.get(clip.model.mesh(pieces[i].part, *clip.backing->full));
      return shape[i];
    };
    const auto deviceOf = [&](uint32_t i) -> const auto& {
      if (!devices[i]) devices[i] = connectors.connectors.get(pieces[i].part, &clip.model.library());
      return *devices[i];
    };
    if (bounds[clip.target].empty()) {
      out.error = "This part has no collision geometry.";
      return out;
    }
    std::vector<bm::Xform> poses(n);
    std::vector<bool> hidden(n);
    struct LastContact {
      int sample = -1;
      size_t row = SIZE_MAX;
    };
    std::vector<LastContact> last(n);
    constexpr size_t visibleLimit = 200;
    for (int frame : frames) {
      const double t = std::clamp((frame - clip.scene.buildStart) * clip.scene.buildSpeed * clip.fps / clip.scene.fps,
                                  0.0, static_cast<double>(clip.timeline.frames));
      for (size_t i = 0; i < n; ++i) poses[i] = pieces[i].world, hidden[i] = false;
      if (clip.scene.buildLinked) {
        std::vector<std::optional<bm::Xform>> sample(clip.timeline.flights.size());
        for (size_t i = 0; i < n && i < clip.owners.size(); ++i) {
          const int owner = clip.owners[i];
          if (owner < 0) continue;
          const size_t index = static_cast<size_t>(owner);
          if (!sample[index]) sample[index] = bm::plan::motionAt(clip.timeline, index, t);
          poses[i] = *sample[index] * poses[i];
          hidden[i] = !bm::plan::shownAt(clip.timeline.flights[index], t);
        }
      }
      for (const auto& keyed : keyPoses(clip.scene, clip.tracks, clip.geometry, clip.model, clip.timeline, clip.owners, t, frame)) {
        poses[keyed.piece] = keyed.world;
        hidden[keyed.piece] = keyed.hidden;
      }
      ++out.testedFrames;
      const uint32_t a = clip.target;
      if (hidden[a]) continue;
      const auto aBox = bounds[a].transformed(poses[a]);
      for (uint32_t b = 0; b < n; ++b) {
        if (b == a || hidden[b] || bounds[b].empty() || !meets(aBox, bounds[b].transformed(poses[b]))) continue;
        std::vector<bm::collide::Zone> zones;
        for (const auto& localA : deviceOf(a)) {
          const auto posedA = bm::connect::transformed(localA, poses[a]);
          for (const auto& localB : deviceOf(b)) {
            const auto posedB = bm::connect::transformed(localB, poses[b]);
            if (!bm::connect::mate(posedA, posedB)) continue;
            const auto zone = bm::connect::mateZone(posedA, posedB);
            zones.push_back({zone.a, zone.b, zone.radius});
          }
        }
        const auto depth = zones.empty() ? bm::collide::Depth::Skin : bm::collide::Depth::Joined;
        if (!bm::collide::overlap(*shapeOf(a), poses[a], *shapeOf(b), poses[b], zones, nullptr, depth)) continue;
        auto& previous = last[b];
        if (previous.sample + 1 != out.testedFrames) {
          ++out.intervals;
          previous.row = SIZE_MAX;
          if (out.contacts.size() < visibleLimit) {
            previous.row = out.contacts.size();
            out.contacts.push_back({a, b, frame, frame, pieces[a].part, pieces[b].part});
          }
        } else if (previous.row < out.contacts.size()) {
          out.contacts[previous.row].lastFrame = frame;
        }
        previous.sample = out.testedFrames;
      }
    }
  } catch (const std::exception& e) {
    out.error = e.what();
  }
  return out;
}

}  // namespace bmapp

void bmappRetainMotionAudit(bmapp::MotionAudit* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseMotionAudit(bmapp::MotionAudit* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
