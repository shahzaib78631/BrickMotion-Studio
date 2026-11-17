// bmshot: one picture of a model, drawn offscreen, to a PNG.
#include <algorithm>
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
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmr/device.h"
#include "bmr/image.h"
#include "bmr/renderer.h"
#include "bmr/scene.h"
#include "engine.h"

namespace fs = std::filesystem;
using namespace bm;

namespace {

constexpr int kOk = 0, kFailure = 1, kUsage = 2;

int usage() {
  std::fprintf(stderr,
               "usage: bmshot <model file> --out <png> [--size WxH] [--frame N] [--azimuth a --elevation e] [--no-edges] [--no-shadows] [--no-ao] [--no-floor]\n"
               "              [--no-cull] [--detail 0|1|2] [--select piece,piece,...] [--stats] [--repeat CxR] [--save-model <ldr>]\n"
               "       bmshot <model file> --bench <frames> [--repeat CxR] [--size WxH] [--detail 0|1|2] [--no-...]\n");
  return kUsage;
}

struct Spread {
  double p50 = 0, p95 = 0, max = 0;
};
Spread spread(std::vector<double> v) {
  Spread s;
  if (v.empty()) return s;
  std::sort(v.begin(), v.end());
  auto at = [&](double q) { return v[std::min(v.size() - 1, static_cast<size_t>(q * (v.size() - 1) + 0.5))]; };
  s.p50 = at(0.5), s.p95 = at(0.95), s.max = v.back();
  return s;
}

/// Frames drawn offscreen, one after another, as the camera goes once round the model at the
/// framing distance. The first kWarmUp are left out (pipelines and buffers settling).
int bench(bmr::Renderer& renderer, const Model& model, int frames, int width, int height, const bmr::FrameOptions& options) {
  constexpr int kWarmUp = 30;
  const double aspect = double(width) / height;
  bmr::OrbitCamera orbit = bmr::OrbitCamera::framing(renderer.scene().bounds, 0.6, aspect);
  std::vector<double> cpu, gpu, total;
  bmr::FrameStats last;
  for (int i = 0; i < kWarmUp + frames; i++) {
    orbit.azimuth = 2 * M_PI * i / (kWarmUp + frames);
    last = renderer.draw(orbit.camera(aspect, renderer.scene().bounds), options);
    if (i < kWarmUp) continue;
    cpu.push_back(last.cpuMs), gpu.push_back(last.gpuMs), total.push_back(last.cpuMs + last.gpuMs);
  }
  auto json = [](const Spread& s) {
    char buf[96];
    std::snprintf(buf, sizeof buf, "{\"p50\":%.3f,\"p95\":%.3f,\"max\":%.3f}", s.p50, s.p95, s.max);
    return std::string(buf);
  };
  std::printf("{\"pieces\":%zu,\"size\":\"%dx%d\",\"triangles\":%llu,\"frames\":%d,\"cpuMs\":%s,\"gpuMs\":%s,\"frameMs\":%s,\"byDetail\":[%u,%u,%u],\"drawCalls\":%u,\"culled\":%u}\n",
              model.pieces().size(), width, height, static_cast<unsigned long long>(last.triangles), frames, json(spread(cpu)).c_str(), json(spread(gpu)).c_str(), json(spread(total)).c_str(),
              last.byDetail[0], last.byDetail[1], last.byDetail[2], last.drawCalls, last.culled);
  return kOk;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty() || args[0].rfind("--", 0) == 0) return usage();
  const fs::path input{std::string(args[0])};
  std::string out, saveModel;
  int width = 1600, height = 1000, detail = -1;
  double azimuth = NAN, elevation = NAN;
  bmr::FrameOptions options;
  bool stats = false;
  int frame = -1, benchFrames = 0, columns = 1, rows = 1;
  std::vector<uint32_t> select;
  for (size_t i = 1; i < args.size(); i++) {
    const std::string_view a = args[i];
    auto value = [&]() -> std::string {
      if (i + 1 >= args.size()) return {};
      return std::string(args[++i]);
    };
    if (a == "--out") out = value();
    else if (a == "--save-model") saveModel = value();
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
    else if (a == "--bench") {
      benchFrames = std::atoi(value().c_str());
      if (benchFrames < 1) return usage();
    } else if (a == "--repeat") {
      const std::string v = value();
      if (std::sscanf(v.c_str(), "%dx%d", &columns, &rows) != 2 || columns < 1 || rows < 1) return usage();
    } else if (a == "--frame") {
      frame = std::atoi(value().c_str());
      if (frame < 0) return usage();
    } else if (a == "--select") {
      std::string list = value();
      for (size_t at = 0; at < list.size();) {
        const size_t comma = std::min(list.find(',', at), list.size());
        select.push_back(static_cast<uint32_t>(std::strtoul(list.substr(at, comma - at).c_str(), nullptr, 10)));
        at = comma + 1;
      }
    }
    else return usage();
  }
  if (out.empty() && benchFrames == 0 && saveModel.empty()) return usage();
  options.forceDetail = detail;
  if (!bmr::gpuAvailable()) {
    std::fprintf(stderr, "bmshot: no Metal device\n");
    return kFailure;
  }
  const std::string ldraw = bmtools::ldrawDir();
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
    const Model loaded = io::load(input, library, &full);
    const Model model = columns * rows > 1 ? bmr::repeated(loaded, full, columns, rows, 80) : loaded;
    if (!saveModel.empty()) {
      // The scene drawn, as one flattened LDraw file (bmview can open the benchmark's scene).
      std::FILE* f = std::fopen(saveModel.c_str(), "wb");
      const std::string text = io::toLDraw(model);
      if (!f || std::fwrite(text.data(), 1, text.size(), f) != text.size()) {
        if (f) std::fclose(f);
        std::fprintf(stderr, "bmshot: cannot write %s\n", saveModel.c_str());
        return kFailure;
      }
      std::fclose(f);
      if (out.empty() && benchFrames == 0) return kOk;
    }
    auto renderer = bmr::Renderer::create(model, full, low);
    if (!renderer) {
      std::fprintf(stderr, "bmshot: cannot draw here: %s\n", bmr::shaderError());
      return kFailure;
    }
    renderer->resize(width, height);
    renderer->select(select);
    if (benchFrames > 0) return bench(*renderer, model, benchFrames, width, height, options);
    const double aspect = double(width) / height;
    const bmr::OrbitCamera defaults;
    bmr::OrbitCamera orbit = bmr::OrbitCamera::fitted(renderer->scene().bounds, 0.6, aspect, std::isnan(azimuth) ? defaults.azimuth : azimuth,
                                                      std::isnan(elevation) ? defaults.elevation : elevation);
    plan::Plan plan;
    plan::Timeline timeline;
    if (frame >= 0) {
      bmtools::Planned planned = bmtools::planModel(model, library, full, ldraw);
      plan = std::move(planned.plan), timeline = std::move(planned.timeline);
      renderer->setFrame(plan, timeline, frame);
      if (!timeline.camera.empty() && std::isnan(azimuth) && std::isnan(elevation)) orbit = bmr::OrbitCamera::along(timeline, frame);
      std::fprintf(stderr, "bmshot: frame %d of %d\n", frame, timeline.frames);
    }
    const bmr::FrameStats s = renderer->draw(orbit.camera(aspect, renderer->scene().bounds), options);
    if (!bmr::writePng(renderer->readback(), out)) {
      std::fprintf(stderr, "bmshot: cannot write %s\n", out.c_str());
      return kFailure;
    }
    size_t skipped = 0, placeholders = 0;
    for (const auto& [g, k] : renderer->scene().where) {
      if (g >= renderer->scene().groups.size()) skipped++;
      else if (renderer->scene().groups[g].placeholder) placeholders++;
    }
    if (stats)
      std::printf("{\"skipped\":%zu,\"placeholders\":%zu,\"cpuMs\":%.3f,\"gpuMs\":%.3f,\"drawCalls\":%u,\"instances\":%u,\"culled\":%u,\"triangles\":%llu,\"byDetail\":[%u,%u,%u],\"pieces\":%zu}\n", skipped, placeholders, s.cpuMs, s.gpuMs,
                  s.drawCalls, s.instances, s.culled, static_cast<unsigned long long>(s.triangles), s.byDetail[0], s.byDetail[1], s.byDetail[2], model.pieces().size());
    return kOk;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "bmshot: %s\n", e.what());
    return kFailure;
  }
}
