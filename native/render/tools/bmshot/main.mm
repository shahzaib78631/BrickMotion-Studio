// bmshot: one picture of a model, drawn offscreen, to a PNG.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>
#include "bm/io.h"
#include "bm/ldraw/part_cache.h"
#include "bmr/device.h"
#include "bmr/image.h"
#include "bmr/renderer.h"

namespace fs = std::filesystem;
using namespace bm;

namespace {

constexpr int kOk = 0, kFailure = 1, kUsage = 2;

int usage() {
  std::fprintf(stderr,
               "usage: bmshot <model file> --out <png> [--size WxH] [--azimuth a --elevation e] [--no-edges] [--no-shadows] [--no-ao] [--no-floor]\n"
               "              [--no-cull] [--detail 0|1|2] [--stats]\n");
  return kUsage;
}

std::string ldrawDir() {
  if (const char* dir = std::getenv("BM_LDRAW_DIR")) return dir;
  std::error_code ec;
  for (fs::path at = fs::current_path(ec); !at.empty(); at = at.parent_path()) {
    if (fs::exists(at / "public" / "ldraw" / "LDConfig.ldr", ec)) return (at / "public" / "ldraw").string();
    if (at == at.root_path()) break;
  }
  return "";
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty() || args[0].rfind("--", 0) == 0) return usage();
  const fs::path input{std::string(args[0])};
  std::string out;
  int width = 1600, height = 1000, detail = -1;
  double azimuth = NAN, elevation = NAN;
  bmr::FrameOptions options;
  bool stats = false;
  for (size_t i = 1; i < args.size(); i++) {
    const std::string_view a = args[i];
    auto value = [&]() -> std::string {
      if (i + 1 >= args.size()) return {};
      return std::string(args[++i]);
    };
    if (a == "--out") out = value();
    else if (a == "--size") {
      const std::string v = value();
      if (std::sscanf(v.c_str(), "%dx%d", &width, &height) != 2 || width < 1 || height < 1) return usage();
    } else if (a == "--azimuth") azimuth = std::atof(value().c_str());
    else if (a == "--elevation") elevation = std::atof(value().c_str());
    else if (a == "--no-edges") options.edges = false;
    else if (a == "--no-shadows") options.shadows = false;
    else if (a == "--no-ao") options.ambientOcclusion = false;
    else if (a == "--no-floor") options.floor = false;
    else if (a == "--no-cull") options.cull = false;
    else if (a == "--detail") {
      detail = std::atoi(value().c_str());
      if (detail < 0 || detail > 2) return usage();
    } else if (a == "--stats") stats = true;
    else return usage();
  }
  if (out.empty()) return usage();
  options.forceDetail = detail;
  if (!bmr::gpuAvailable()) {
    std::fprintf(stderr, "bmshot: no Metal device\n");
    return kFailure;
  }
  const std::string ldraw = ldrawDir();
  if (ldraw.empty()) {
    std::fprintf(stderr, "bmshot: no LDraw library found; set BM_LDRAW_DIR\n");
    return kFailure;
  }
  try {
    const ldraw::Library library(ldraw);
    ldraw::PartCache full(library, ldraw::PartCache::defaultDirectory());
    ldraw::FlattenOptions lowOptions;
    lowOptions.lowResPrimitives = true;
    ldraw::PartCache low(library, ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", lowOptions);
    const Model model = io::load(input, library, &full);
    auto renderer = bmr::Renderer::create(model, full, low);
    if (!renderer) {
      std::fprintf(stderr, "bmshot: cannot draw here: %s\n", bmr::shaderError());
      return kFailure;
    }
    renderer->resize(width, height);
    const double aspect = double(width) / height;
    const bmr::OrbitCamera defaults;
    const bmr::OrbitCamera orbit = bmr::OrbitCamera::fitted(renderer->scene().bounds, 0.6, aspect, std::isnan(azimuth) ? defaults.azimuth : azimuth,
                                                            std::isnan(elevation) ? defaults.elevation : elevation);
    const bmr::FrameStats s = renderer->draw(orbit.camera(aspect, renderer->scene().bounds), options);
    if (!bmr::writePng(renderer->readback(), out)) {
      std::fprintf(stderr, "bmshot: cannot write %s\n", out.c_str());
      return kFailure;
    }
    if (stats)
      std::printf("{\"cpuMs\":%.3f,\"gpuMs\":%.3f,\"drawCalls\":%u,\"instances\":%u,\"culled\":%u,\"triangles\":%llu,\"byDetail\":[%u,%u,%u],\"pieces\":%zu}\n", s.cpuMs, s.gpuMs,
                  s.drawCalls, s.instances, s.culled, static_cast<unsigned long long>(s.triangles), s.byDetail[0], s.byDetail[1], s.byDetail[2], model.pieces().size());
    return kOk;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bmshot: %s\n", e.what());
    return kFailure;
  }
}
