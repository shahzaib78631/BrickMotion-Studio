// bmexport: path-traced, denoised pictures of a model (and, later, its film and snap track).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
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
               "                [--size WxH] [--azimuth a --elevation e | --eye x,y,z --target x,y,z] [--fov deg] [--lights-fixed|--lights-follow] [--background r,g,b] [--repeat CxR]\n");
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
    const Model model = shot.columns * shot.rows > 1 ? bmr::repeated(loaded, full, shot.columns, shot.rows, 80) : loaded;
    bmr::Scene scene = bmr::buildScene(model, full);
    bmr::MeshLibrary meshes(model, full, low);
    bmr::OrbitCamera orbit;
    if (!bmtools::shotCamera(shot, scene.bounds, nullptr, orbit)) return usage();
    if (shot.frame >= 0) {
      const bmtools::Planned planned = bmtools::planModel(model, library, full, ldraw);
      bmr::applyFrame(scene, model, planned.plan, planned.timeline, shot.frame);
      bmtools::shotCamera(shot, scene.bounds, &planned.timeline, orbit);
      std::fprintf(stderr, "bmexport: frame %d of %d\n", shot.frame, planned.timeline.frames);
    }
    const auto start = std::chrono::steady_clock::now();
    path->prepare(scene, meshes);
    bmr::PathOptions options;
    options.width = shot.width, options.height = shot.height;
    options.samples = samples;
    options.seed = seed;
    options.lightsFollowCamera = shot.lightsFollow;
    if (shot.backgroundSet) std::copy(std::begin(shot.background), std::end(shot.background), std::begin(options.background));
    bmr::PathImage image = tracer->render(*path, orbit.camera(double(shot.width) / shot.height, scene.bounds), options);
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

}  // namespace

int main(int argc, char** argv) {
  const std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty()) return usage();
  if (args[0] == "still") return still(args);
  return usage();
}
