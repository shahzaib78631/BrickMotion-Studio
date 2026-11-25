// Build settings, staging & waiting parts, and snap sound settings over bmapp.
#include <string>

#include "bmapp/snap_mix.h"
#include "bmffi.h"
#include "internal.h"

namespace {

BmBuildOrder fromOrder(bmapp::BuildOrder o) {
  return o == bmapp::BuildOrder::BottomUp ? BM_ORDER_BOTTOM_UP : BM_ORDER_TAKE_APART;
}
bmapp::BuildOrder toOrder(BmBuildOrder o) {
  return o == BM_ORDER_BOTTOM_UP ? bmapp::BuildOrder::BottomUp : bmapp::BuildOrder::TakeApart;
}

BmFlightShape fromFlight(bmapp::FlightShape f) {
  switch (f) {
    case bmapp::FlightShape::Web: return BM_FLIGHT_WEB;
    case bmapp::FlightShape::Arc: return BM_FLIGHT_ARC;
    default: return BM_FLIGHT_AUTOMATIC;
  }
}
bmapp::FlightShape toFlight(BmFlightShape f) {
  switch (f) {
    case BM_FLIGHT_WEB: return bmapp::FlightShape::Web;
    case BM_FLIGHT_ARC: return bmapp::FlightShape::Arc;
    default: return bmapp::FlightShape::Automatic;
  }
}

BmBuildSettings fromBuild(const bmapp::BuildSettings& b) {
  return BmBuildSettings{b.standardPlanner, fromOrder(b.order), fromFlight(b.flight), b.cleanGrownUnits,
                         b.piecesPerSecond, b.gap, b.stepPause, b.clearance, b.corner, b.videoSeconds};
}
bmapp::BuildSettings toBuild(const BmBuildSettings& b) {
  bmapp::BuildSettings out;
  out.standardPlanner = b.standard_planner;
  out.order = toOrder(b.order);
  out.flight = toFlight(b.flight);
  out.cleanGrownUnits = b.clean_grown_units;
  out.piecesPerSecond = b.pieces_per_second;
  out.gap = b.gap;
  out.stepPause = b.step_pause;
  out.clearance = b.clearance;
  out.corner = b.corner;
  out.videoSeconds = b.video_seconds;
  return out;
}

bmapp::StagingSettings toStaging(const BmStagingSettings& s) {
  bmapp::StagingSettings out;
  if (s.layout) out.layout = s.layout;
  if (s.group) out.group = s.group;
  if (s.sides) out.sides = s.sides;
  if (s.match) out.match = s.match;
  out.aspect = s.aspect;
  return out;
}

BmSnapSource fromSource(bmapp::SnapSource s) {
  switch (s) {
    case bmapp::SnapSource::Recorded: return BM_SNAP_RECORDED;
    case bmapp::SnapSource::Synthesised: return BM_SNAP_SYNTHESISED;
    default: return BM_SNAP_PHYSICAL;
  }
}
bmapp::SnapSource toSource(BmSnapSource s) {
  switch (s) {
    case BM_SNAP_RECORDED: return bmapp::SnapSource::Recorded;
    case BM_SNAP_SYNTHESISED: return bmapp::SnapSource::Synthesised;
    default: return bmapp::SnapSource::Physical;
  }
}

BmSnapLibrary fromLibrary(bmapp::SnapLibrary l) {
  switch (l) {
    case bmapp::SnapLibrary::Freesound: return BM_SNAP_FREESOUND;
    case bmapp::SnapLibrary::OpenGameArt: return BM_SNAP_OPENGAMEART;
    default: return BM_SNAP_ALL;
  }
}
bmapp::SnapLibrary toLibrary(BmSnapLibrary l) {
  switch (l) {
    case BM_SNAP_FREESOUND: return bmapp::SnapLibrary::Freesound;
    case BM_SNAP_OPENGAMEART: return bmapp::SnapLibrary::OpenGameArt;
    default: return bmapp::SnapLibrary::All;
  }
}

bmapp::SnapExample toExample(BmSnapExample e) {
  switch (e) {
    case BM_SNAP_PLATE: return bmapp::SnapExample::Plate;
    case BM_SNAP_PIN: return bmapp::SnapExample::Pin;
    default: return bmapp::SnapExample::Brick;
  }
}

BmSnapMix fromSnap(const bmapp::SnapMix& m) {
  return BmSnapMix{m.enabled, fromSource(m.source), fromLibrary(m.library), m.volume, m.room, m.stereo,
                   m.click, m.brightness, m.thump, m.thumpPitch, m.thumpLength, m.pitch, m.variation,
                   m.sizePitch, m.sizeMatch, m.together};
}
bmapp::SnapMix toSnap(const BmSnapMix& m) {
  bmapp::SnapMix out;
  out.enabled = m.enabled;
  out.source = toSource(m.source);
  out.library = toLibrary(m.library);
  out.volume = m.volume;
  out.room = m.room;
  out.stereo = m.stereo;
  out.click = m.click;
  out.brightness = m.brightness;
  out.thump = m.thump;
  out.thumpPitch = m.thump_pitch;
  out.thumpLength = m.thump_length;
  out.pitch = m.pitch;
  out.variation = m.variation;
  out.sizePitch = m.size_pitch;
  out.sizeMatch = m.size_match;
  out.together = m.together;
  return out;
}

}  // namespace

extern "C" {

BmBuildSettings bm_session_build_settings(const BmSession* s) {
  const BmBuildSettings def = fromBuild(bmapp::BuildSettings{});
  if (!s) return def;
  return bmffi::guard(def, [&] { return fromBuild(s->s->buildSettings()); });
}

BmChange bm_session_set_build_settings(BmSession* s, BmBuildSettings settings) {
  return bmffi::change(s, [&] { return s->s->setBuildSettings(toBuild(settings)); });
}

BmStagingSettings bm_session_staging_settings(const BmSession* s) {
  thread_local bmapp::StagingSettings cached;
  cached = bmapp::StagingSettings{};
  if (s) {
    bmffi::guardVoid([&] { cached = s->s->stagingSettings(); });
  }
  return BmStagingSettings{cached.layout.c_str(), cached.group.c_str(), cached.sides.c_str(),
                           cached.match.c_str(), cached.aspect};
}

BmChange bm_session_set_staging_settings(BmSession* s, BmStagingSettings settings) {
  return bmffi::change(s, [&] { return s->s->setStagingSettings(toStaging(settings)); });
}

double bm_session_staging_turn(const BmSession* s) {
  if (!s) return 0;
  return bmffi::guard(0.0, [&] { return s->s->stagingTurn(); });
}

BmChange bm_session_set_staging_turn(BmSession* s, double degrees) {
  return bmffi::change(s, [&] { return s->s->setStagingTurn(degrees); });
}

size_t bm_session_moved_waiting_parts(const BmSession* s) {
  if (!s) return 0;
  return bmffi::guard<size_t>(0, [&] { return s->s->movedWaitingParts(); });
}

BmChange bm_session_put_back_waiting_parts(BmSession* s) {
  return bmffi::change(s, [&] { return s->s->putBackWaitingParts(); });
}

BmChange bm_session_apply_staging(BmSession* s, BmStagingSettings settings, double turn, bool straighten) {
  return bmffi::change(s, [&] { return s->s->applyStaging(toStaging(settings), turn, straighten); });
}

BmChange bm_session_turn_waiting_part(BmSession* s, uint32_t piece, double degrees) {
  return bmffi::change(s, [&] { return s->s->turnWaitingPart(piece, degrees); });
}

bool bm_viewport_can_turn_waiting_part(const BmViewport* v, uint32_t piece) {
  if (!v) return false;
  return bmffi::guard(false, [&] { return v->v->canTurnWaitingPart(piece); });
}

double bm_viewport_waiting_turn_to_match(const BmViewport* v, uint32_t piece) {
  if (!v) return 0;
  return bmffi::guard(0.0, [&] { return v->v->waitingTurnToMatch(piece); });
}

bool bm_viewport_can_move_waiting_part(const BmViewport* v, uint32_t piece) {
  if (!v) return false;
  return bmffi::guard(false, [&] { return v->v->canMoveWaitingPart(piece); });
}

bool bm_viewport_begin_waiting_drag(BmViewport* v, uint32_t piece, double x, double y) {
  if (!v) return false;
  return bmffi::guard(false, [&] { return v->v->beginWaitingDrag(piece, x, y); });
}

BmVec3 bm_viewport_drag_waiting_part(BmViewport* v, double x, double y) {
  if (!v) return BmVec3{0, 0, 0};
  return bmffi::guard(BmVec3{0, 0, 0}, [&] { return bmffi::from_vec3(v->v->dragWaitingPart(x, y)); });
}

BmVec3 bm_viewport_end_waiting_drag(BmViewport* v) {
  if (!v) return BmVec3{0, 0, 0};
  return bmffi::guard(BmVec3{0, 0, 0}, [&] { return bmffi::from_vec3(v->v->endWaitingDrag()); });
}

BmChange bm_session_shift_waiting_part(BmSession* s, uint32_t piece, BmVec3 delta) {
  return bmffi::change(s, [&] { return s->s->shiftWaitingPart(piece, bmffi::to_vec3(delta)); });
}

BmVec3 bm_session_waiting_shift(const BmSession* s, uint32_t piece) {
  if (!s) return BmVec3{0, 0, 0};
  return bmffi::guard(BmVec3{0, 0, 0}, [&] { return bmffi::from_vec3(s->s->waitingShift(piece)); });
}

BmSnapMix bm_session_snap_mix(const BmSession* s) {
  const BmSnapMix def = fromSnap(bmapp::SnapMix{});
  if (!s) return def;
  return bmffi::guard(def, [&] { return fromSnap(s->s->snapMix()); });
}

BmChange bm_session_set_snap_mix(BmSession* s, BmSnapMix mix) {
  return bmffi::change(s, [&] { return s->s->setSnapMix(toSnap(mix)); });
}

BmSnapMix bm_snap_mix_preset(const char* name) {
  const BmSnapMix def = fromSnap(bmapp::SnapMix{});
  return bmffi::guard(def, [&] { return fromSnap(bmapp::snapMixPreset(name ? name : "")); });
}

bool bm_write_snap_preview(BmSnapMix mix, BmSnapExample example, const char* recordings, const char* file) {
  if (!file) return false;
  return bmffi::guard(false, [&] {
    return bmapp::writeSnapPreview(toSnap(mix), toExample(example), recordings ? recordings : "", file);
  });
}

BmString bm_viewport_write_snap_track(BmViewport* v, const char* file, const char* recordings) {
  if (!v || !file) return bmffi::make("no viewport");
  return bmffi::guard(bmffi::make("failed to write snap track"), [&] {
    return bmffi::make(v->v->writeSnapTrack(file, recordings ? recordings : ""));
  });
}

}  // extern "C"
