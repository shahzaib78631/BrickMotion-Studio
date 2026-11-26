// The project's look, file exports and the export windows' options over bmapp.
#include <string>
#include <vector>

#include "bmapp/export_options.h"
#include "bmffi.h"
#include "internal.h"

struct BmScenes {
  bmapp::ScenePresets items;
};
struct BmVideoTargets {
  std::vector<bmapp::VideoTarget> items;
};

namespace {

using bmffi::guard;
using bmffi::make;

std::string str(const char* p) { return p ? p : ""; }

bmapp::Shading toShading(int32_t s) {
  switch (s) {
    case 1: return bmapp::Shading::Studio;
    case 2: return bmapp::Shading::Neural;
    case 3: return bmapp::Shading::HybridRT;
    case 4: return bmapp::Shading::ScreenSpaceGI;
    case 5: return bmapp::Shading::PathTraced;
    default: return bmapp::Shading::Standard;
  }
}

bmapp::RenderLook toLook(const BmRenderLook& l) {
  bmapp::RenderLook out;
  out.scene = str(l.scene);
  out.shading = toShading(l.shading);
  out.edges = l.edges;
  out.shadows = l.shadows;
  out.ambientOcclusion = l.ambient_occlusion;
  out.floor = l.floor;
  out.raytracedGlass = l.raytraced_glass;
  out.worldGiOcclusion = l.world_gi_occlusion;
  out.lightsFollowCamera = l.lights_follow_camera;
  out.pathSamples = l.path_samples;
  return out;
}

template <typename E>
E pick(int32_t v, int32_t count, E fallback) {
  return v >= 0 && v < count ? static_cast<E>(v) : fallback;
}

bmapp::ViewAngles toAngles(const BmViewAngles& a) {
  return {a.present, a.yaw_deg, a.pitch_deg, a.fov_deg, a.orthographic};
}

bmapp::MovieChoice toMovie(const BmMovieChoice& c) {
  bmapp::MovieChoice out;
  out.source = pick(c.source, 3, bmapp::MovieSource::Build);
  out.shape = pick(c.shape, 4, bmapp::FrameShape::Landscape);
  out.resolution = pick(c.resolution, 3, bmapp::MovieResolution::Standard);
  out.quality = pick(c.quality, 3, bmapp::MovieQuality::Standard);
  out.fps = c.fps;
  out.turntableSeconds = c.turntable_seconds;
  out.camera = pick(c.camera, 4, bmapp::MovieCamera::Director);
  out.sceneCameraId = str(c.scene_camera_id);
  out.snapAudio = c.snap_audio;
  out.standardPreview = c.standard_preview;
  out.angles = toAngles(c.angles);
  for (size_t i = 0; c.model_path && i < c.model_path_len; ++i) out.modelPath.push_back(str(c.model_path[i]));
  out.logo = str(c.logo);
  out.logoCorner = pick(c.logo_corner, 4, bmapp::LogoCorner::BottomRight);
  return out;
}

bmapp::StillQuality toSamples(int32_t samples) {
  return samples == 32 ? bmapp::StillQuality::Draft : samples == 512 ? bmapp::StillQuality::Final : bmapp::StillQuality::Standard;
}

bmapp::StillChoice toStill(const BmStillChoice& c) {
  bmapp::StillChoice out;
  out.shape = pick(c.shape, 4, bmapp::FrameShape::Landscape);
  out.large = c.large;
  out.quality = toSamples(c.samples);
  out.viewportAngle = c.viewport_angle;
  out.angles = toAngles(c.angles);
  return out;
}

BmStrings* strings(const bmapp::StringList& list) { return new BmStrings{list}; }

}  // namespace

extern "C" {

BmRenderLook bm_session_render_look(const BmSession* s) {
  thread_local bmapp::RenderLook cached;
  cached = bmapp::RenderLook{};
  if (s) bmffi::guardVoid([&] { cached = s->s->renderLook(); });
  return BmRenderLook{cached.scene.c_str(), static_cast<int32_t>(cached.shading), cached.edges, cached.shadows,
                      cached.ambientOcclusion, cached.floor, cached.raytracedGlass, cached.worldGiOcclusion,
                      cached.lightsFollowCamera, cached.pathSamples};
}

BmChange bm_session_set_render_look(BmSession* s, BmRenderLook look) {
  return bmffi::change(s, [&] { return s->s->setRenderLook(toLook(look)); });
}

BmScenes* bm_scenes(void) {
  return bmffi::handle<BmScenes>([] { return new BmScenes{bmapp::Session::scenes()}; });
}
size_t bm_scenes_len(const BmScenes* s) { return s ? s->items.size() : 0; }
BmScenePreset bm_scenes_at(const BmScenes* s, size_t i) {
  if (!s || i >= s->items.size()) return BmScenePreset{"", "", "", 0, {0, 0, 0}, false};
  const auto& p = s->items[i];
  return BmScenePreset{p.id.c_str(), p.label.c_str(), p.hint.c_str(), static_cast<int32_t>(p.collection),
                       bmffi::from_vec3(p.background), p.floor};
}
void bm_scenes_free(BmScenes* s) { delete s; }

BmString bm_session_plan_bytes(const BmSession* s) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->planBytes()); });
}
BmString bm_session_mpd_bytes(const BmSession* s) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->mpdBytes()); });
}
BmString bm_session_submodel_mpd_bytes(const BmSession* s, const char* model) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->submodelMpdBytes(str(model))); });
}
BmString bm_session_submodel_project_bytes(const BmSession* s, const char* model) {
  if (!s) return make("");
  return guard<BmString>(make(""), [&] { return make(s->s->submodelProjectBytes(str(model))); });
}

BmFrameSize bm_movie_size(int32_t shape, int32_t resolution) {
  const auto size = bmapp::movieSize(pick(shape, 4, bmapp::FrameShape::Landscape),
                                     pick(resolution, 3, bmapp::MovieResolution::Standard));
  return BmFrameSize{size.width, size.height};
}
BmFrameSize bm_still_size(int32_t shape, bool large) {
  const auto size = bmapp::stillSize(pick(shape, 4, bmapp::FrameShape::Landscape), large);
  return BmFrameSize{size.width, size.height};
}
int32_t bm_movie_bit_rate(int32_t width, int32_t height, int32_t fps, int32_t quality) {
  return bmapp::movieBitRate(width, height, fps, pick(quality, 3, bmapp::MovieQuality::Standard));
}
BmViewAngles bm_view_angles(BmCamera camera) {
  const auto a = bmapp::viewAngles(bmffi::to_camera(camera));
  return BmViewAngles{a.present, a.yawDeg, a.pitchDeg, a.fovDeg, a.orthographic};
}

BmStrings* bm_movie_arguments(BmMovieChoice choice) {
  return bmffi::handle<BmStrings>([&] { return strings(bmapp::movieArguments(toMovie(choice))); });
}
BmString bm_movie_summary(BmMovieChoice choice) {
  return guard<BmString>(make(""), [&] { return make(bmapp::movieSummary(toMovie(choice))); });
}
BmStrings* bm_still_arguments(BmStillChoice choice, BmRenderLook look) {
  return bmffi::handle<BmStrings>([&] { return strings(bmapp::stillArguments(toStill(choice), toLook(look))); });
}
BmString bm_still_summary(BmStillChoice choice, bool logo) {
  return guard<BmString>(make(""), [&] { return make(bmapp::stillSummary(toStill(choice), logo)); });
}

int32_t bm_default_movie_camera(const BmSession* s, bool batch, bool has_angle) {
  if (!s) return 0;
  return guard<int32_t>(0, [&] { return static_cast<int32_t>(bmapp::defaultMovieCamera(*s->s, batch, has_angle)); });
}
bool bm_movie_allows_track(const BmSession* s, BmMovieChoice choice, bool batch, bool focused_model_chosen) {
  if (!s) return false;
  return guard(false, [&] { return bmapp::movieAllowsTrack(*s->s, toMovie(choice), batch, focused_model_chosen); });
}

BmVideoTargets* bm_submodel_video_targets(const BmSession* s, const char* const* ids, size_t n, bool filter) {
  if (!s) return nullptr;
  return bmffi::handle<BmVideoTargets>([&] {
    if (!filter) return new BmVideoTargets{bmapp::submodelVideoTargets(*s->s)};
    bmapp::StringList list;
    for (size_t i = 0; ids && i < n; ++i) list.push_back(str(ids[i]));
    return new BmVideoTargets{bmapp::submodelVideoTargets(*s->s, list)};
  });
}
size_t bm_video_targets_len(const BmVideoTargets* t) { return t ? t->items.size() : 0; }
const char* bm_video_targets_title(const BmVideoTargets* t, size_t i) {
  return t && i < t->items.size() ? t->items[i].title.c_str() : "";
}
size_t bm_video_targets_path_len(const BmVideoTargets* t, size_t i) {
  return t && i < t->items.size() ? t->items[i].path.size() : 0;
}
const char* bm_video_targets_path_at(const BmVideoTargets* t, size_t i, size_t j) {
  return t && i < t->items.size() && j < t->items[i].path.size() ? t->items[i].path[j].c_str() : "";
}
void bm_video_targets_free(BmVideoTargets* t) { delete t; }

BmString bm_safe_file_stem(const char* name) {
  return guard<BmString>(make("Submodel"), [&] { return make(bmapp::safeFileStem(str(name))); });
}

BmString bm_display_name(const char* raw) {
  return guard<BmString>(make(""), [&] { return make(bmapp::displayName(str(raw))); });
}

BmString bm_stamp_logo(const char* png, const char* logo, int32_t corner) {
  return guard<BmString>(make("The still could not be drawn."), [&] {
    return make(bmapp::stampLogo(str(png), str(logo), pick(corner, 4, bmapp::LogoCorner::BottomRight)));
  });
}

int32_t bm_run_editor_movie(const char* const* args, size_t n) {
  return guard<int32_t>(1, [&] {
    std::vector<std::string> list;
    for (size_t i = 0; args && i < n; ++i) list.push_back(str(args[i]));
    return bmapp::runEditorMovie(list);
  });
}

}  // extern "C"
