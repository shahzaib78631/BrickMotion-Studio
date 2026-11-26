// Look, file exports, export options and the viewport recorder over bmffi.
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <string>
#include <vector>

#include "bmffi.h"

namespace {

const char* kHeli = BM_REPO "/samples/helicopter/helicopter.mpd";

BmSession* openHeli() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeli);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

std::string take(BmString s) {
  std::string out = s.ptr ? std::string(s.ptr, s.len) : std::string();
  bm_string_free(s);
  return out;
}

std::string joined(BmStrings* list) {
  std::string out;
  for (size_t i = 0; i < bm_strings_len(list); ++i) out += (out.empty() ? "" : " ") + std::string(bm_strings_at(list, i));
  bm_strings_free(list);
  return out;
}

}  // namespace

TEST_CASE("look round-trips with one undo step", "[export]") {
  BmSession* s = openHeli();
  BmRenderLook look = bm_session_render_look(s);
  CHECK(look.edges);
  const auto depth = bm_session_undo_depth(s);
  std::string scene = "slate-blue";
  look.scene = scene.c_str();
  look.edges = false;
  look.path_samples = 256;
  BmChange c = bm_session_set_render_look(s, look);
  CHECK(std::string(c.refused.ptr ? c.refused.ptr : "") == "");
  bm_change_free(c);
  const BmRenderLook back = bm_session_render_look(s);
  CHECK(std::string(back.scene) == scene);
  CHECK_FALSE(back.edges);
  CHECK(back.path_samples == 256);
  CHECK(bm_session_undo_depth(s) == depth + 1);
  bm_session_free(s);
}

TEST_CASE("scenes are listed", "[export]") {
  BmScenes* scenes = bm_scenes();
  CHECK(bm_scenes_len(scenes) == 34);
  const BmScenePreset first = bm_scenes_at(scenes, 0);
  CHECK(std::string(first.id).size() > 0);
  CHECK(std::string(first.label).size() > 0);
  bm_scenes_free(scenes);
}

TEST_CASE("file bytes", "[export]") {
  BmSession* s = openHeli();
  const std::string plan = take(bm_session_plan_bytes(s));
  CHECK(plan.front() == '{');
  CHECK(plan.find("\"brickmotion-plan\"") != std::string::npos);
  CHECK(take(bm_session_mpd_bytes(s)).rfind("0 FILE", 0) == 0);
  CHECK(take(bm_session_submodel_mpd_bytes(s, "helicopter - underside 1.ldr")).rfind("0 FILE", 0) == 0);
  CHECK(take(bm_session_submodel_project_bytes(s, "helicopter - underside 1.ldr")).front() == '{');
  bm_session_free(s);
}

TEST_CASE("export options match bmapp", "[export]") {
  const BmFrameSize small = bm_movie_size(2, 0);
  CHECK(small.width == 720);
  CHECK(small.height == 900);
  CHECK(bm_still_size(0, true).width == 3840);
  CHECK(bm_movie_bit_rate(1920, 1080, 30, 1) == 12'441'600);
  const char* path[] = {"sub.ldr"};
  BmMovieChoice movie{};
  movie.source = 0, movie.shape = 0, movie.resolution = 1, movie.quality = 1, movie.fps = 30;
  movie.turntable_seconds = 8, movie.camera = 1, movie.snap_audio = true;
  movie.model_path = path, movie.model_path_len = 1, movie.logo = "/tmp/l.png", movie.logo_corner = 0;
  CHECK(joined(bm_movie_arguments(movie)) ==
        "--size 1920x1080 --fps 30 --source build --snap-audio --camera-track --logo /tmp/l.png --logo-corner tl --model sub.ldr");
  CHECK(take(bm_movie_summary(movie)) == "Build · 1920 × 1080 · 30 fps · Logo");
  BmStillChoice still{0, false, 128, false, {}};
  BmRenderLook look{};
  look.scene = "";
  CHECK(joined(bm_still_arguments(still, look)) == "--size 1920x1080 --samples 128 --no-denoise --lights-fixed");
  CHECK(take(bm_still_summary(still, false)) == "Still · 1920 × 1080 · Standard");
  CHECK(take(bm_safe_file_stem("a/b:c")) == "a b c");
  const BmViewAngles angles = bm_view_angles(BmCamera{0, 0, 100, {0, 0, 0}, true, 0.6});
  CHECK(angles.present);
  CHECK(angles.orthographic);

  BmSession* s = openHeli();
  CHECK(bm_default_movie_camera(s, true, false) == 0);
  CHECK_FALSE(bm_movie_allows_track(s, movie, false, false));  // no camera keys
  BmVideoTargets* targets = bm_submodel_video_targets(s, nullptr, 0, false);
  REQUIRE(bm_video_targets_len(targets) == 1);
  CHECK(std::string(bm_video_targets_title(targets, 0)) == "helicopter - underside 1");
  REQUIRE(bm_video_targets_path_len(targets, 0) == 1);
  CHECK(std::string(bm_video_targets_path_at(targets, 0, 0)) == "helicopter - underside 1.ldr");
  bm_video_targets_free(targets);
  BmVideoTargets* none = bm_submodel_video_targets(s, nullptr, 0, true);
  CHECK(bm_video_targets_len(none) == 0);
  bm_video_targets_free(none);
  bm_session_free(s);
  const char* bad[] = {kHeli};
  CHECK(bm_run_editor_movie(bad, 1) == 1);  // no destination
}

TEST_CASE("recorder writes the frames it is given", "[export]") {
  const auto file = std::filesystem::temp_directory_path() / "bmffi-recorder-test.mp4";
  std::filesystem::remove(file);
  BmString error{nullptr, 0};
  BmRecorder* r = bm_recorder_start(file.c_str(), 63, 47, &error);  // made even: 64 × 48
  REQUIRE(r);
  CHECK(bm_recorder_size(r).width == 64);
  CHECK(bm_recorder_size(r).height == 48);
  std::vector<uint8_t> rgba(63 * 47 * 4, 200);
  for (int i = 0; i < 4; ++i) CHECK(bm_recorder_append(r, rgba.data(), rgba.size(), 63, 47, i / 30.0));
  CHECK(take(bm_recorder_finish(r)).empty());
  CHECK(bm_movie_frame_count(file.c_str()) == 4);
  CHECK(bm_movie_frame_count("/nonexistent.mp4") == -1);
  CHECK(bm_movie_audio_seconds(file.c_str()) == -1);  // a viewport recording has no sound
  std::filesystem::remove(file);
}
