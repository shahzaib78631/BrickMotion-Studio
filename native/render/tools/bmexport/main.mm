// bmexport: path-traced, denoised pictures of a model (and, later, its film and snap track).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>
#include "bm/io.h"
#include "bm/ldraw/part_cache.h"
#include "bmr/denoise.h"
#include "bmr/image.h"
#include "bmr/path_scene.h"
#include "bmr/path_tracer.h"
#include "bmr/render_mesh.h"
#include "bmr/scene.h"
#include "bms/snap_events.h"
#include "bms/snap_synth.h"
#include "bms/wav.h"
#include "engine.h"
#include "shot_options.h"

namespace fs = std::filesystem;
using namespace bm;

namespace {

constexpr int kOk = 0, kFailure = 1, kCannot = 2, kUsage = 2;

/// The light rigs bmexport knows. The web app's other looks are photo environments (HDRI), out
/// of this phase.
constexpr const char* kRigs[] = {"build-fl"};

int usage() {
  std::fprintf(stderr,
               "usage: bmexport still <model file> --out <png> [--frame N] [--samples S] [--seed K] [--rig build-fl] [--no-denoise] [--denoise-device cpu|metal]\n"
               "                [--size WxH] [--azimuth a --elevation e | --eye x,y,z --target x,y,z] [--fov deg] [--lights-fixed|--lights-follow] [--background r,g,b] [--repeat CxR] [--correct]\n"
               "       bmexport sound <model file> --out <wav> [--size WxH] [sound options]   the build's snaps, 48 kHz stereo (--size: the film's shape, for panning)\n"
               "       bmexport sound-gallery <dir> [sound options]          the listening cases, one WAV each\n"
               "         sound options: --style physics|web   physics (default): the parts' own sound; web: the web app's snap\n"
               "                        --web-preset balanced|product|click|soft|synth   the web app's preset (implies --style web)\n"
               "                        --recordings <dir>   the web's recorded snaps (default: the repo's public/sounds/snaps)\n");
  return kUsage;
}

double msSince(std::chrono::steady_clock::time_point t) { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count(); }

int still(const std::vector<std::string_view>& args) {
  if (args.size() < 2 || args[1].rfind("--", 0) == 0) return usage();
  const fs::path input{std::string(args[1])};
  bmtools::ShotOptions shot;
  int samples = 256;
  uint64_t seed = 0;
  std::string rig = "build-fl";
  bool denoising = true;
  bmr::DenoiseDevice device = bmr::DenoiseDevice::Cpu;
  for (size_t i = 2; i < args.size(); i++) {
    const int shared = bmtools::parseShotOption(shot, args, i);
    if (shared < 0) return usage();
    if (shared > 0) continue;
    const std::string_view a = args[i];
    auto value = [&]() -> std::string {
      if (i + 1 >= args.size()) return {};
      return std::string(args[++i]);
    };
    if (a == "--samples") {
      samples = std::atoi(value().c_str());
      if (samples < 1) return usage();
    } else if (a == "--seed") {
      const std::string v = value();
      char* end = nullptr;
      seed = std::strtoull(v.c_str(), &end, 10);
      if (v.empty() || *end) return usage();
    } else if (a == "--rig") rig = value();
    else if (a == "--no-denoise") denoising = false;
    else if (a == "--denoise-device") {
      const std::string v = value();
      if (v == "cpu") device = bmr::DenoiseDevice::Cpu;
      else if (v == "metal") device = bmr::DenoiseDevice::Metal;
      else return usage();
    } else return usage();
  }
  if (shot.out.empty()) return usage();
  if (shot.strip > 0) return usage();  // contact sheets are bmshot's
  bool known = false;
  for (const char* r : kRigs) known = known || rig == r;
  if (!known) {
    std::string list;
    for (const char* r : kRigs) list += (list.empty() ? "" : ", ") + std::string(r);
    std::fprintf(stderr, "bmexport: no rig '%s'; the rigs are: %s\n", rig.c_str(), list.c_str());
    return kUsage;
  }
  // What this machine and build cannot do is said before any work, in one line.
  std::string error;
  auto path = bmr::PathScene::create(&error);
  auto tracer = path ? bmr::PathTracer::create(&error) : nullptr;
  if (!path || !tracer) {
    std::fprintf(stderr, "bmexport: cannot path-trace here: %s\n", error.c_str());
    return kCannot;
  }
  if (denoising && !bmr::denoiserAvailable()) {
    std::fprintf(stderr, "bmexport: this build has no denoiser (OIDN was not in vendor/oidn); use --no-denoise\n");
    return kCannot;
  }
  const std::string ldraw = bmtools::ldrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bmexport: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  try {
    const ldraw::Library library(ldraw);
    ldraw::PartCache full(library, ldraw::PartCache::defaultDirectory());
    ldraw::FlattenOptions lowOptions;
    lowOptions.lowResPrimitives = true;
    ldraw::PartCache low(library, ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", lowOptions);
    const Model loaded = io::load(input, library, &full);
    Model model = shot.columns * shot.rows > 1 ? bmr::repeated(loaded, full, shot.columns, shot.rows, 80) : loaded;
    // Planned before the scene is built when it changes what is drawn (--correct), or a frame is asked for.
    std::optional<bmtools::Planned> planned;
    if (shot.frame >= 0 || shot.correct) {
      bm::plan::Options planOptions;
      planOptions.correctPlacements = shot.correct;
      planned = bmtools::planModel(model, library, full, ldraw, planOptions, bmtools::styleWith(input, shot), double(shot.width) / shot.height);
      bmtools::reportCorrections("bmexport", model, planned->corrections);
    }
    bmr::Scene scene = bmr::buildScene(model, full);
    bmr::MeshLibrary meshes(model, full, low);
    bmr::OrbitCamera orbit;
    if (!bmtools::shotCamera(shot, scene.bounds, nullptr, orbit)) return usage();
    if (shot.frame >= 0) {
      bmr::applyFrame(scene, model, planned->plan, planned->timeline, shot.frame);
      bmtools::shotCamera(shot, scene.bounds, &planned->timeline, orbit);
      std::fprintf(stderr, "bmexport: frame %d of %d\n", shot.frame, planned->timeline.frames);
    }
    const auto start = std::chrono::steady_clock::now();
    path->prepare(scene, meshes);
    bmr::PathOptions options;
    options.width = shot.width, options.height = shot.height;
    options.samples = samples;
    options.seed = seed;
    options.lightsFollowCamera = shot.lightsFollow;
    if (shot.backgroundSet) std::copy(std::begin(shot.background), std::end(shot.background), std::begin(options.background));
    // At a frame of the build with no camera given, the director's camera.
    const double aspect = double(shot.width) / shot.height;
    bmr::Camera camera = shot.directorFilms() ? bmtools::toCamera(film::cameraAt(planned->track, shot.frame), aspect, scene.bounds) : orbit.camera(aspect, scene.bounds);
    if (shot.directorFilms() && std::isfinite(shot.fovDegrees)) camera.fovY = shot.fovDegrees * M_PI / 180;
    bmr::PathImage image = tracer->render(*path, camera, options);
    const double traceMs = msSince(start);
    const auto denoiseStart = std::chrono::steady_clock::now();
    if (denoising && !bmr::denoise(image, device, &error)) {
      std::fprintf(stderr, "bmexport: cannot denoise: %s\n", error.c_str());
      return kFailure;
    }
    const double denoiseMs = denoising ? msSince(denoiseStart) : 0;
    if (!bmr::writePng(bmr::toImage(image), shot.out)) {
      std::fprintf(stderr, "bmexport: cannot write %s\n", shot.out.c_str());
      return kFailure;
    }
    std::fprintf(stderr, "bmexport: %dx%d, %d samples, traced in %.0f ms, denoised in %.0f ms\n", shot.width, shot.height, samples, traceMs, denoiseMs);
    return kOk;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bmexport: %s\n", e.what());
    return kFailure;
  }
}

/// Writes to a temporary name beside `file`, then renames: a half-written file is never left.
bool writeWavAtomically(bms::Mixer& mixer, const fs::path& file) {
  const fs::path temporary = file.string() + ".part";
  if (!bms::writeWav(mixer, temporary)) return false;
  std::error_code ec;
  fs::rename(temporary, file, ec);
  return !ec;
}

/// The sound options at args[i] (it moves past their values): 1 taken, 0 not a sound option, -1 bad.
int parseSoundOption(bms::SoundOptions& o, const std::vector<std::string_view>& args, size_t& i) {
  const std::string_view a = args[i];
  if (a != "--style" && a != "--web-preset" && a != "--recordings") return 0;
  if (i + 1 >= args.size()) return -1;
  const std::string_view v = args[++i];
  if (a == "--style") {
    if (v == "physics") o.style = bms::SoundStyle::Physics;
    else if (v == "web") o.style = bms::SoundStyle::Web;
    else return -1;
  } else if (a == "--web-preset") {
    if (!bms::webPreset(v, o.web)) return -1;
    o.style = bms::SoundStyle::Web;
  } else {
    o.recordings = std::string(v);
  }
  return 1;
}
bms::SoundOptions defaultSound() {
  bms::SoundOptions o;
  o.recordings = BM_WEB_SNAPS;
  return o;
}
/// What the track will sound like, for the summary line.
std::string describe(const bms::SoundOptions& o) {
  if (o.style == bms::SoundStyle::Physics) return "physics";
  if (!o.web.recorded) return "web, synthesised";
  return bms::loadRecordings(o.recordings).empty() ? "web, synthesised (no recordings in " + o.recordings.string() + ")" : "web, recorded";
}

int sound(const std::vector<std::string_view>& args) {
  if (args.size() < 2 || args[1].rfind("--", 0) == 0) return usage();
  const fs::path input{std::string(args[1])};
  bmtools::ShotOptions shot;
  shot.width = 1920, shot.height = 1080;
  bms::SoundOptions options = defaultSound();
  for (size_t i = 2; i < args.size(); i++) {
    const int own = parseSoundOption(options, args, i);
    if (own < 0) return usage();
    if (own > 0) continue;
    const int shared = bmtools::parseShotOption(shot, args, i);
    if (shared <= 0) return usage();
  }
  if (shot.out.empty()) return usage();
  const std::string ldraw = bmtools::ldrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bmexport: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  try {
    const ldraw::Library library(ldraw);
    ldraw::PartCache full(library, ldraw::PartCache::defaultDirectory());
    Model model = io::load(input, library, &full);
    bm::plan::Options planOptions;
    planOptions.correctPlacements = shot.correct;
    const bmtools::Planned planned = bmtools::planModel(model, library, full, ldraw, planOptions, bmtools::styleWith(input, shot), double(shot.width) / shot.height);
    bmtools::reportCorrections("bmexport", model, planned.corrections);
    const bmr::Scene scene = bmr::buildScene(model, full);
    std::vector<Box> boxes(model.pieces().size());
    for (size_t p = 0; p < boxes.size() && p < scene.where.size(); p++) {
      const auto [g, k] = scene.where[p];
      if (g < scene.groups.size() && k < scene.groups[g].restBoxes.size()) boxes[p] = scene.groups[g].restBoxes[k];
    }
    const double aspect = double(shot.width) / shot.height;
    auto screenX = [&](int frame, Vec3 point) {
      // Heard as the director's camera films it.
      const bmr::Camera c = planned.track.frames.empty() ? bmr::OrbitCamera::framing(scene.bounds, 0.6, aspect).camera(aspect, scene.bounds) : bmtools::toCamera(film::cameraAt(planned.track, frame), aspect, scene.bounds);
      const Vec3 forward = normalized(c.target - c.eye), right = normalized(cross(forward, c.up));
      const double depth = dot(point - c.eye, forward);
      return depth > 1e-6 ? dot(point - c.eye, right) / (depth * std::tan(c.fovY / 2) * aspect) : 0.0;
    };
    std::vector<bms::SnapEvent> events = bms::snapEvents(model, planned.graph, planned.plan, planned.timeline, boxes, screenX);
    const size_t count = events.size();
    bms::Mixer mixer(std::move(events), planned.timeline.frames, plan::Style{}.fps, options);
    const auto start = std::chrono::steady_clock::now();
    if (!writeWavAtomically(mixer, shot.out)) {
      std::fprintf(stderr, "bmexport: cannot write %s\n", shot.out.c_str());
      return kFailure;
    }
    std::fprintf(stderr, "bmexport: %zu snaps over %.1f s (%d frames), %s, mixed in %.0f ms\n", count, planned.timeline.frames / plan::Style{}.fps, planned.timeline.frames, describe(options).c_str(), msSince(start));
    return kOk;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bmexport: %s\n", e.what());
    return kFailure;
  }
}

/// The phase 7 plan's listening cases, as events made by hand (so each is exactly the case named).
int soundGallery(const std::vector<std::string_view>& args) {
  if (args.size() < 2 || args[1].rfind("--", 0) == 0) return usage();
  bms::SoundOptions options = defaultSound();
  for (size_t i = 2; i < args.size(); i++)
    if (parseSoundOption(options, args, i) <= 0) return usage();
  const fs::path dir{std::string(args[1])};
  std::error_code ec;
  fs::create_directories(dir, ec);
  auto box = [](double w, double h, double d, double top) {
    Box b;
    b.grow({-w / 2, top - 4, -d / 2});
    b.grow({w / 2, top + h, d / 2});
    return b;
  };
  auto event = [&](int frame, uint32_t move, uint16_t mates, Box unit, Box touching, uint32_t built) {
    bms::SnapEvent e;
    e.frame = frame, e.move = move, e.mates = mates, e.grip = 4.0 * mates;
    e.unit = unit, e.touching = touching, e.built = touching;
    e.built.merge(unit);
    e.builtPieces = built, e.seatSeconds = 0.125;
    return e;
  };
  struct Case {
    const char* name;
    std::vector<bms::SnapEvent> events;
    int frames;
  };
  std::vector<Case> cases;
  cases.push_back({"1-tile-1x1-on-plate", {event(15, 1, 1, box(20, 8, 20, -8), box(80, 8, 80, 0), 1)}, 45});
  cases.push_back({"2-brick-2x4-on-2x4", {event(15, 1, 8, box(80, 24, 40, -24), box(80, 24, 40, 0), 1)}, 45});
  {
    bms::SnapEvent big = event(15, 1, 8, box(80, 24, 40, -24), box(80, 24, 40, 0), 2000);
    big.built = box(640, 320, 480, 0);  // a model about 26 x 19 cm: what rings is its size, not its count
    cases.push_back({"3-brick-2x4-onto-2000-pieces", {big}, 45});
  }
  {
    bms::SnapEvent pin = event(15, 1, 2, box(40, 16, 16, -16), box(120, 20, 20, 0), 1);
    pin.ridge = true, pin.joint = connect::JointKind::Revolute;
    cases.push_back({"4-technic-pin", {pin}, 45});
    bms::SnapEvent axle = event(15, 1, 2, box(80, 8, 8, -8), box(120, 20, 20, 0), 1);
    axle.joint = connect::JointKind::Cylindrical, axle.seatSeconds = 0.08;
    cases.push_back({"5-axle", {axle}, 45});
  }
  {
    std::vector<bms::SnapEvent> row;
    for (int i = 0; i < 20; i++) {
      bms::SnapEvent e = event(15 + 15 * i, static_cast<uint32_t>(i + 1), 2, box(40, 8, 20, -8), box(800, 8, 80, 0), static_cast<uint32_t>(i + 1));
      e.pan = -0.8 + 1.6 * i / 19.0;
      row.push_back(e);
    }
    cases.push_back({"6-twenty-1x2-plates", row, 15 + 15 * 20 + 30});
  }
  for (Case& c : cases) {
    bms::Mixer mixer(std::move(c.events), c.frames, plan::Style{}.fps, options);
    const fs::path file = dir / (std::string(c.name) + ".wav");
    if (!writeWavAtomically(mixer, file)) {
      std::fprintf(stderr, "bmexport: cannot write %s\n", file.c_str());
      return kFailure;
    }
    std::printf("%s\n", file.c_str());
  }
  return kOk;
}

}  // namespace

int main(int argc, char** argv) {
  const std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty()) return usage();
  if (args[0] == "still") return still(args);
  if (args[0] == "sound") return sound(args);
  if (args[0] == "sound-gallery") return soundGallery(args);
  return usage();
}
