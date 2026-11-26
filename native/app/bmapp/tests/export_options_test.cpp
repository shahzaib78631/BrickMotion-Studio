// Export options: the rules the Swift sheets kept, moved down so both app shells share them.
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <filesystem>
#include <string>
#include "bmapp/export_options.h"
#include "bmapp/session.h"
#include "bmr/image.h"
#include "movie_logo.h"

namespace fs = std::filesystem;

namespace {
std::string joined(const bmapp::StringList& list) {
  std::string out;
  for (const auto& item : list) out += (out.empty() ? "" : " ") + item;
  return out;
}
fs::path helicopter() { return fs::path(BM_REPO) / "samples" / "helicopter" / "helicopter.mpd"; }
}  // namespace

TEST_CASE("frame sizes match Swift", "[export]") {
  using bmapp::FrameShape;
  using bmapp::MovieResolution;
  auto size = [](FrameShape shape, MovieResolution r) {
    const auto s = bmapp::movieSize(shape, r);
    return std::to_string(s.width) + "x" + std::to_string(s.height);
  };
  CHECK(size(FrameShape::Landscape, MovieResolution::Small) == "1280x720");
  CHECK(size(FrameShape::Landscape, MovieResolution::Standard) == "1920x1080");
  CHECK(size(FrameShape::Landscape, MovieResolution::Large) == "3840x2160");
  CHECK(size(FrameShape::Vertical, MovieResolution::Small) == "720x1280");
  CHECK(size(FrameShape::Vertical, MovieResolution::Large) == "2160x3840");
  CHECK(size(FrameShape::Portrait, MovieResolution::Small) == "720x900");
  CHECK(size(FrameShape::Portrait, MovieResolution::Standard) == "1080x1350");
  CHECK(size(FrameShape::Square, MovieResolution::Small) == "720x720");
  CHECK(size(FrameShape::Square, MovieResolution::Large) == "2160x2160");
  CHECK(bmapp::stillSize(FrameShape::Portrait, true).width == 2160);
  CHECK(bmapp::stillSize(FrameShape::Portrait, true).height == 2700);
  CHECK(bmapp::stillSize(FrameShape::Square, false).width == 1080);
  CHECK(std::string(bmapp::frameRatio(FrameShape::Landscape)) == "16:9");
  CHECK(std::string(bmapp::frameRatio(FrameShape::Vertical)) == "9:16");
  CHECK(std::string(bmapp::frameRatio(FrameShape::Portrait)) == "4:5");
  CHECK(std::string(bmapp::frameRatio(FrameShape::Square)) == "1:1");
}

TEST_CASE("bit rate", "[export]") {
  using bmapp::MovieQuality;
  CHECK(bmapp::movieBitRate(1920, 1080, 30, MovieQuality::Standard) == 12'441'600);
  CHECK(bmapp::movieBitRate(320, 180, 24, MovieQuality::Compact) == 480'000);
  CHECK(bmapp::movieBitRate(3840, 2160, 60, MovieQuality::High) == 159'252'480);
  CHECK(bmapp::movieBitRate(7680, 4320, 60, MovieQuality::High) == 240'000'000);
}

TEST_CASE("movie arguments order", "[export]") {
  bmapp::MovieChoice choice;
  choice.camera = bmapp::MovieCamera::Track;
  choice.snapAudio = true;
  choice.modelPath = {"sub.ldr"};
  choice.logo = "/tmp/l.png";
  choice.logoCorner = bmapp::LogoCorner::TopLeft;
  // VideoExportSheet.options(for:): --bitrate only off Standard; the model path and heading last.
  CHECK(joined(bmapp::movieArguments(choice)) ==
        "--size 1920x1080 --fps 30 --source build --snap-audio --camera-track --logo /tmp/l.png --logo-corner tl --model sub.ldr");
  choice.quality = bmapp::MovieQuality::High;
  choice.camera = bmapp::MovieCamera::Viewport;
  choice.angles = {true, 45, 30, 34.5, true};
  CHECK(joined(bmapp::movieArguments(choice)) ==
        "--size 1920x1080 --fps 30 --source build --bitrate 19906560 --snap-audio --logo /tmp/l.png --logo-corner tl "
        "--model sub.ldr --azimuth 45 --elevation 30 --fov 34.5 --orthographic");
}

TEST_CASE("turntable adds duration", "[export]") {
  bmapp::MovieChoice choice;
  choice.source = bmapp::MovieSource::Turntable;
  choice.turntableSeconds = 12;
  choice.snapAudio = true;
  CHECK(joined(bmapp::movieArguments(choice)) == "--size 1920x1080 --fps 30 --source turntable --duration 12");
}

TEST_CASE("standard preview drops snap audio", "[export]") {
  bmapp::MovieChoice choice;
  choice.standardPreview = true;
  choice.snapAudio = true;
  CHECK(joined(bmapp::movieArguments(choice)) == "--size 1920x1080 --fps 30 --source build --standard-preview");
}

TEST_CASE("saved camera passes its id", "[export]") {
  bmapp::MovieChoice choice;
  choice.source = bmapp::MovieSource::Keyframes;
  choice.camera = bmapp::MovieCamera::Saved;
  choice.sceneCameraId = "c1";
  CHECK(joined(bmapp::movieArguments(choice)) == "--size 1920x1080 --fps 30 --source keyframes --scene-camera c1");
}

TEST_CASE("default camera", "[export]") {
  bmapp::Session s;
  REQUIRE(s.open(helicopter().string()).ok);
  s.setExportCamera("buildView");
  CHECK(bmapp::defaultMovieCamera(s, false, false) == bmapp::MovieCamera::Director);
  CHECK(bmapp::defaultMovieCamera(s, false, true) == bmapp::MovieCamera::Viewport);
  s.setExportCamera("automatic");
  CHECK(bmapp::defaultMovieCamera(s, false, true) == bmapp::MovieCamera::Director);
  s.setExportCamera("track");
  CHECK(bmapp::defaultMovieCamera(s, false, true) == bmapp::MovieCamera::Director);  // no keys yet
  bmapp::SceneCamera front;
  front.position = {0, -60, -400}, front.target = {0, -40, 0}, front.fieldOfView = 30;
  REQUIRE(s.addCameraKey(bmapp::CameraClock::Build, 0, front, 30, 10).refused.empty());
  REQUIRE_FALSE(s.cameraKeys(bmapp::CameraClock::Build).empty());
  CHECK(bmapp::defaultMovieCamera(s, false, true) == bmapp::MovieCamera::Track);
  CHECK(bmapp::defaultMovieCamera(s, true, true) == bmapp::MovieCamera::Director);

  bmapp::MovieChoice choice;
  CHECK(bmapp::movieAllowsTrack(s, choice, false, false));
  CHECK_FALSE(bmapp::movieAllowsTrack(s, choice, true, false));
  choice.source = bmapp::MovieSource::Keyframes;
  CHECK_FALSE(bmapp::movieAllowsTrack(s, choice, false, false));
  choice.source = bmapp::MovieSource::Turntable;
  CHECK_FALSE(bmapp::movieAllowsTrack(s, choice, false, false));
}

TEST_CASE("still arguments", "[export]") {
  bmapp::StillChoice choice;
  choice.angles = {true, 45, -20, 34.5, true};
  bmapp::RenderLook look;
  look.scene = "";
  CHECK(joined(bmapp::stillArguments(choice, look)) ==
        "--size 1920x1080 --samples 128 --no-denoise --azimuth 45 --elevation -20 --fov 34.5 --lights-fixed");
  const auto scenes = bmapp::Session::scenes();
  REQUIRE_FALSE(scenes.empty());
  const auto& scene = scenes.front();
  look.scene = scene.id;
  look.lightsFollowCamera = true;
  choice.viewportAngle = false;
  choice.large = true;
  choice.quality = bmapp::StillQuality::Final;
  auto byte = [](double v) { return std::to_string(static_cast<int>(std::lround(v * 255))); };
  CHECK(joined(bmapp::stillArguments(choice, look)) ==
        "--size 3840x2160 --samples 512 --no-denoise --lights-follow --background " + byte(scene.background.x) + "," +
            byte(scene.background.y) + "," + byte(scene.background.z));
}

TEST_CASE("summaries", "[export]") {
  bmapp::MovieChoice movie;
  CHECK(bmapp::movieSummary(movie) == "Build · 1920 × 1080 · 30 fps");
  movie.source = bmapp::MovieSource::Turntable;
  movie.resolution = bmapp::MovieResolution::Small;
  movie.fps = 60;
  movie.quality = bmapp::MovieQuality::High;
  movie.logo = "/tmp/l.png";
  CHECK(bmapp::movieSummary(movie) == "Turntable · 1280 × 720 · 60 fps · High · Logo");
  bmapp::StillChoice still;
  CHECK(bmapp::stillSummary(still, false) == "Still · 1920 × 1080 · Standard");
  still.quality = bmapp::StillQuality::Draft;
  still.shape = bmapp::FrameShape::Square;
  CHECK(bmapp::stillSummary(still, true) == "Still · 1080 × 1080 · Draft · Logo");
}

TEST_CASE("safe_file_stem_cases", "[export]") {
  CHECK(bmapp::safeFileStem("a/b:c") == "a b c");
  CHECK(bmapp::safeFileStem("..x..") == "x");
  CHECK(bmapp::safeFileStem("") == "Submodel");
  CHECK(bmapp::safeFileStem(" . / . ") == "Submodel");
  CHECK(bmapp::safeFileStem("  Rotor\tblade \n") == "Rotor blade");
  CHECK(bmapp::safeFileStem(std::string(70, 'x')) == std::string(60, 'x'));
  CHECK(bmapp::safeFileStem(std::string(59, 'x') + " y") == std::string(59, 'x'));  // the cut is trimmed again
  // Swift's controlCharacters is Cc and Cf; its trim set is all Unicode white space.
  CHECK(bmapp::safeFileStem("Wing\xE2\x80\x8BL") == "Wing L");     // U+200B zero width space
  CHECK(bmapp::safeFileStem("a\xE2\x80\xAE" "b") == "a b");          // U+202E right-to-left override
  CHECK(bmapp::safeFileStem("\xEF\xBB\xBFx") == "x");               // U+FEFF
  CHECK(bmapp::safeFileStem("\xE3\x80\x80x\xE2\x80\x83") == "x");  // U+3000, U+2003
  std::string wide;
  for (int i = 0; i < 70; ++i) wide += "\xE2\x82\xAC";  // €, three bytes
  CHECK(bmapp::safeFileStem(wide).size() == 180);       // 60 code points
}

TEST_CASE("submodel targets", "[export]") {
  bmapp::Session s;
  REQUIRE(s.open((fs::path(BM_FIXTURES) / "models" / "twice.mpd").string()).ok);
  const auto targets = bmapp::submodelVideoTargets(s);
  REQUIRE(targets.size() == 1);  // "wheel pair" is used twice; custom.dat is a part
  CHECK(targets[0].title == "wheel pair");
  REQUIRE(targets[0].path.size() == 1);
  CHECK(targets[0].path[0] == "wheel pair.ldr");
  CHECK(bmapp::submodelVideoTargets(s, bmapp::StringList{}).empty());

  bmapp::Session h;
  REQUIRE(h.open(helicopter().string()).ok);
  const auto heli = bmapp::submodelVideoTargets(h);
  REQUIRE(heli.size() == 1);
  CHECK(heli[0].title == "helicopter - underside 1");
}

TEST_CASE("stamp logo", "[export]") {
  const auto dir = fs::temp_directory_path() / "bmapp-stamp-test";
  fs::create_directories(dir);
  bmr::Image still{1080, 1080, std::vector<uint8_t>(1080 * 1080 * 4, 255)};
  bmr::Image logo{100, 50, {}};
  for (int i = 0; i < 100 * 50; ++i) logo.rgba.insert(logo.rgba.end(), {255, 0, 0, 255});
  REQUIRE(bmr::writePng(still, dir / "still.png"));
  REQUIRE(bmr::writePng(logo, dir / "logo.png"));
  CHECK(bmapp::stampLogo((dir / "still.png").string(), (dir / "logo.png").string(), bmapp::LogoCorner::TopRight).empty());
  const auto out = bmr::readPng(dir / "still.png");
  REQUIRE(out.width == 1080);
  const auto rect = bmapp::logoRect(1080, 1080, 100, 50, bmapp::LogoCorner::TopRight);
  const auto* inside = out.at(static_cast<int>(rect.x + rect.width / 2), static_cast<int>(rect.y + rect.height / 2));
  CHECK(inside[0] == 255);
  CHECK(inside[1] >= 20);   // 90 % red over white: 255 · 0.1 ≈ 26
  CHECK(inside[1] <= 32);
  const auto* outside = out.at(10, 1070);
  CHECK(outside[1] == 255);
  CHECK(bmapp::stampLogo((dir / "missing.png").string(), (dir / "logo.png").string(), bmapp::LogoCorner::TopRight) ==
        "The rendered still could not be read.");
  CHECK(bmapp::stampLogo((dir / "still.png").string(), (dir / "missing.png").string(), bmapp::LogoCorner::TopRight) ==
        "The logo could not be read.");
  fs::remove_all(dir);
}

TEST_CASE("editor movie refuses bad arguments", "[export]") {
  const auto project = helicopter().string();
  CHECK(bmapp::runEditorMovie({}) == 1);
  CHECK(bmapp::runEditorMovie({project}) == 1);                               // no destination
  CHECK(bmapp::runEditorMovie({project, "--out", "/tmp/x.mp4", "--size", "12"}) == 1);
  CHECK(bmapp::runEditorMovie({project, "--out", "/tmp/x.mp4", "--bitrate", "5"}) == 1);
  CHECK(bmapp::runEditorMovie({project, "--out", "/tmp/x.mp4", "--logo-corner", "middle"}) == 1);
  CHECK(bmapp::runEditorMovie({project, "--out", "/tmp/x.mp4", "--wobble", "1"}) == 1);
  CHECK(bmapp::runEditorMovie({project, "--out"}) == 1);
  CHECK(bmapp::runEditorMovie({project, "--out", "/tmp/x.mp4", "--source", "turntable", "--snap-audio"}) == 1);
}
