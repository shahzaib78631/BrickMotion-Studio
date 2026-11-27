// bmshot: one picture of a model, drawn offscreen, to a PNG.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>
#include "bm/io.h"
#include "bm/ldraw/part_cache.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bmr/device.h"
#include "bmr/image.h"
#include "bmr/material.h"
#include "bmr/renderer.h"
#include "bmr/scene.h"
#include "bmr/tolerances.h"
#include "bmr/world_renderer.h"
#include "engine.h"
#include "shot_options.h"

namespace fs = std::filesystem;
using namespace bm;

namespace {

constexpr int kOk = 0, kFailure = 1, kUsage = 2;

int usage() {
  std::fprintf(stderr,
               "usage: bmshot <model file> --out <png> [--size WxH] [--frame N | --strip N] [--azimuth a --elevation e | --eye x,y,z --target x,y,z] [--fov deg] [--no-edges] [--no-shadows] [--no-ao] [--no-floor]\n"
               "              [--no-cull] [--lights-fixed|--lights-follow] [--raytraced-glass] [--background r,g,b] [--detail 0|1|2] [--select piece,piece,...] [--stats] [--repeat CxR] [--save-model <ldr>] [--correct] [--flight web|arc]\n"
               "       bmshot <model file> --bench <frames> [--frame N] [--repeat CxR] [--size WxH] [--detail 0|1|2] [--maps-whole] [--no-...]\n");
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
/// framing distance. The first kWarmUp are left out (pipelines and buffers settling). With a
/// timeline, the build plays as well, one of its frames per frame drawn from `first` on.
int bench(bmr::Renderer& renderer, const Model& model, int frames, int width, int height, const bmr::FrameOptions& options, const plan::Plan* plan = nullptr,
          const plan::Timeline* timeline = nullptr, int first = 0) {
  constexpr int kWarmUp = 30;
  const double aspect = double(width) / height;
  bmr::OrbitCamera orbit = bmr::OrbitCamera::framing(renderer.scene().bounds, 0.6, aspect);
  bmr::FrameOptions viewer = options;  // as the viewer draws: the maps drawn again over frames, unless --maps-whole
  if (viewer.mapTrianglesPerFrame == 0) viewer.mapTrianglesPerFrame = bmr::kMapTrianglesPerFrame;
  if (viewer.mapTrianglesPerFrame == UINT64_MAX) viewer.mapTrianglesPerFrame = 0;
  std::vector<double> cpu, gpu, total;
  bmr::FrameStats last;
  uint64_t shadowTriangles = 0;  // the most drawn into the shadow map in one frame
  int wholeMaps = 0;             // frames before which a map was drawn whole
  for (int i = 0; i < kWarmUp + frames; i++) {
    orbit.azimuth = 2 * M_PI * i / (kWarmUp + frames);
    if (plan && timeline) renderer.setFrame(*plan, *timeline, std::min(first + i, timeline->frames));
    last = renderer.draw(orbit.camera(aspect, renderer.scene().bounds), viewer);
    shadowTriangles = std::max(shadowTriangles, last.shadowTriangles);
    if (i < kWarmUp) continue;
    wholeMaps += last.mapWhole ? 1 : 0;
    cpu.push_back(last.cpuMs), gpu.push_back(last.gpuMs), total.push_back(last.cpuMs + last.gpuMs);
  }
  auto json = [](const Spread& s) {
    char buf[96];
    std::snprintf(buf, sizeof buf, "{\"p50\":%.3f,\"p95\":%.3f,\"max\":%.3f}", s.p50, s.p95, s.max);
    return std::string(buf);
  };
  std::printf("{\"pieces\":%zu,\"size\":\"%dx%d\",\"triangles\":%llu,\"shadowTriangles\":%llu,\"wholeMapFrames\":%d,\"frames\":%d,\"cpuMs\":%s,\"gpuMs\":%s,\"frameMs\":%s,\"byDetail\":[%u,%u,%u],\"drawCalls\":%u,\"culled\":%u}\n",
              model.pieces().size(), width, height, static_cast<unsigned long long>(last.triangles), static_cast<unsigned long long>(shadowTriangles), wholeMaps, frames, json(spread(cpu)).c_str(), json(spread(gpu)).c_str(), json(spread(total)).c_str(),
              last.byDetail[0], last.byDetail[1], last.byDetail[2], last.drawCalls, last.culled);
  return kOk;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty() || args[0].rfind("--", 0) == 0) return usage();
  const fs::path input{std::string(args[0])};
  bmtools::ShotOptions shot;
  std::string saveModel;
  int detail = -1;
  bmr::FrameOptions options;
  bmr::WorldFrameOptions worldOpt;
  bool worldFloorExplicit = false;
  std::string hdrPath;
  bool stats = false;
  int benchFrames = 0;
  int rtptFrames = 0;
  std::vector<uint32_t> select;
  for (size_t i = 1; i < args.size(); i++) {
    const int shared = bmtools::parseShotOption(shot, args, i);
    if (shared < 0) return usage();
    if (shared > 0) continue;
    const std::string_view a = args[i];
    auto value = [&]() -> std::string {
      if (i + 1 >= args.size()) return {};
      return std::string(args[++i]);
    };
    if (a == "--save-model") saveModel = value();
    else if (a == "--no-edges") options.edges = false;
    else if (a == "--no-shadows") options.shadows = false;
    else if (a == "--no-ao") options.ambientOcclusion = false;
    else if (a == "--no-floor") { options.floor = false; worldOpt.floor = false; worldFloorExplicit = true; }
    else if (a == "--floor") { options.floor = true; worldOpt.floor = true; worldFloorExplicit = true; }
    else if (a == "--no-cull") options.cull = false;
    else if (a == "--raytraced-glass") options.refractiveGlass = true;
    else if (a == "--ssgi") options.screenSpaceGi = true;
    else if (a == "--hybrid-rt") options.hybridRt = true;
    else if (a == "--studio") options.studioLook = true;
    else if (a == "--neural") options.neuralShader = true;
    else if (a == "--clay") { options.clay = true; worldOpt.clay = true; }
    else if (a == "--studio-rig") { worldOpt.studioRig = true; }
    else if (a == "--hdr") { hdrPath = value(); }
    else if (a == "--sun") {
      const std::string s = value();
      if (std::sscanf(s.c_str(), "%f,%f,%f", &worldOpt.sunDir[0], &worldOpt.sunDir[1], &worldOpt.sunDir[2]) != 3) return usage();
    }
    else if (a == "--sun-intensity") { worldOpt.sunIntensity = std::strtof(value().c_str(), nullptr); }
    else if (a == "--sky-intensity") { worldOpt.skyIntensity = std::strtof(value().c_str(), nullptr); }
    else if (a == "--exposure") { worldOpt.exposure = std::strtof(value().c_str(), nullptr); }
    else if (a == "--pt") {
      options.pathTraced = true;
      options.pathMaxSamples = std::max(1, std::atoi(value().c_str()));
      options.pathSamplesPerFrame = options.pathMaxSamples;
    }
    else if (a == "--rtpt") {
      options.realtimePathTrace = true;
    }
    else if (a == "--rtpt-frames") {
      options.realtimePathTrace = true;
      rtptFrames = std::max(1, std::atoi(value().c_str()));
    }
    else if (a == "--maps-whole") options.mapTrianglesPerFrame = UINT64_MAX;  // bench only: every stale map drawn whole
    else if (a == "--detail") {
      detail = std::atoi(value().c_str());
      if (detail < 0 || detail > 2) return usage();
    } else if (a == "--stats") stats = true;
    else if (a == "--bench") {
      benchFrames = std::atoi(value().c_str());
      if (benchFrames < 1) return usage();
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
  options.lightsFollowCamera = shot.lightsFollow;
  if (shot.backgroundSet) {
    std::copy(std::begin(shot.background), std::end(shot.background), std::begin(options.background));
    std::copy(std::begin(shot.background), std::end(shot.background), std::begin(worldOpt.background));
  }
  const std::string& out = shot.out;
  const int width = shot.width, height = shot.height, frame = shot.frame, columns = shot.columns, rows = shot.rows;
  if (out.empty() && benchFrames == 0 && saveModel.empty()) return usage();
  if (benchFrames == 0) options.mapTrianglesPerFrame = 0;  // a still is drawn whole
  options.forceDetail = detail;
  if (!bmr::gpuAvailable()) {
    std::fprintf(stderr, "bmshot: cannot draw here: %s\n", *bmr::shaderError() ? bmr::shaderError() : "no Metal device");
    return kFailure;
  }

  // Native zero-conversion 3D World Asset path (.glb / .gltf / .obj + .mtl + PBR textures + .hdr skybox).
  if (bmr::isWorldAssetFile(input)) {
    std::string err;
    const auto tLoad0 = std::chrono::steady_clock::now();
    bmr::WorldAsset asset = bmr::loadWorldAsset(input, &err);
    if (asset.meshes.empty()) {
      std::fprintf(stderr, "bmshot: failed to load %s: %s\n", input.c_str(), err.c_str());
      return kFailure;
    }
    auto wr = bmr::WorldRenderer::create(asset, &err);
    if (!wr) {
      std::fprintf(stderr, "bmshot: WorldRenderer init failed: %s\n", err.c_str());
      return kFailure;
    }
    const double loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tLoad0).count();
    if (!hdrPath.empty() && !wr->loadEnvironmentHdr(hdrPath)) {
      std::fprintf(stderr, "bmshot: warning: failed to load HDR skybox %s\n", hdrPath.c_str());
    }
    if (worldOpt.studioRig && !worldFloorExplicit) worldOpt.floor = true;
    wr->resize(width, height);

    const double aspect = double(width) / height;
    const bm::Box& b = wr->bounds();
    const bm::Vec3 center = (b.min + b.max) * 0.5;
    const double diag = std::max(0.05, bm::length(b.max - b.min));
    bmr::Camera cam;
    cam.up = {0, 1, 0};
    cam.aspect = aspect;
    cam.fovY = (std::isfinite(shot.fovDegrees) ? shot.fovDegrees : (asset.hasDefaultView ? asset.defaultFovDeg : 45.0)) * M_PI / 180.0;
    if (shot.explicitCamera) {
      cam.eye = shot.eye;
      cam.target = shot.target;
    } else if (asset.hasDefaultView && std::isnan(shot.azimuth) && std::isnan(shot.elevation)) {
      cam.eye = asset.defaultEye;
      cam.target = asset.defaultTarget;
    } else {
      const double az = std::isnan(shot.azimuth) ? 0.62 : shot.azimuth;
      const double el = std::isnan(shot.elevation) ? 0.24 : shot.elevation;
      const double halfY = cam.fovY * 0.5;
      const double halfX = std::atan(std::tan(halfY) * aspect);
      const double radius = diag * 0.5;
      const double dist = 1.02 * radius / std::sin(std::min(halfY, halfX));
      const double ce = std::cos(el);
      cam.target = center;
      cam.eye = center + bm::Vec3{ce * std::sin(az), std::sin(el), ce * std::cos(az)} * dist;
    }
    cam.near = std::max(diag * 2e-4, 0.01);
    cam.far = std::max(bm::length(center - cam.eye) + diag * 2.0, diag * 4.0);

    if (benchFrames > 0) {
      constexpr int kWarmUp = 10;
      std::vector<double> cpu, gpu, total;
      bmr::FrameStats last;
      const bm::Vec3 baseEye = cam.eye, baseTarget = cam.target;
      const bm::Vec3 fwd = bm::normalized(baseTarget - baseEye);
      const bm::Vec3 rgt = bm::normalized(bm::cross(fwd, bm::Vec3{0, 1, 0}));
      for (int i = 0; i < kWarmUp + benchFrames; i++) {
        bmr::Camera c = cam;
        const double t = static_cast<double>(i) / static_cast<double>(kWarmUp + benchFrames);
        if (asset.hasDefaultView && !shot.explicitCamera) {
          // Smooth interactive camera pan through the street/atrium (exercises motion vectors & SVGF!).
          const double sway = std::sin(t * 2.0 * M_PI) * (diag * 0.008);
          c.eye = baseEye + rgt * sway;
          c.target = baseTarget + rgt * (sway * 0.35);
        } else {
          const double ang = 2.0 * M_PI * t;
          const bm::Vec3 rel = baseEye - baseTarget;
          const double ca = std::cos(ang), sa = std::sin(ang);
          c.eye = baseTarget + bm::Vec3{rel.x * ca + rel.z * sa, rel.y, -rel.x * sa + rel.z * ca};
        }
        last = wr->draw(c, worldOpt);
        if (i < kWarmUp) continue;
        cpu.push_back(last.cpuMs);
        gpu.push_back(last.gpuMs);
        total.push_back(last.cpuMs + last.gpuMs);
      }
      auto json = [](const Spread& s) {
        char buf[96];
        std::snprintf(buf, sizeof buf, "{\"p50\":%.3f,\"p95\":%.3f,\"max\":%.3f}", s.p50, s.p95, s.max);
        return std::string(buf);
      };
      const Spread gs = spread(gpu);
      const double fps = gs.p50 > 0.01 ? 1000.0 / gs.p50 : 0.0;
      std::printf("{\"world\":true,\"size\":\"%dx%d\",\"triangles\":%llu,\"meshes\":%u,\"textures\":%u,\"loadMs\":%.1f,\"frames\":%d,\"fps\":%.1f,\"cpuMs\":%s,\"gpuMs\":%s,\"frameMs\":%s,\"drawCalls\":%u}\n",
                  width, height, static_cast<unsigned long long>(wr->triangleCount()), wr->meshCount(), wr->textureCount(),
                  loadMs, benchFrames, fps, json(spread(cpu)).c_str(), json(gs).c_str(), json(spread(total)).c_str(), last.drawCalls);
      return kOk;
    }

    const int draws = rtptFrames > 0 ? rtptFrames : 24;
    bmr::FrameStats s;
    for (int d = 0; d < draws; d++) s = wr->draw(cam, worldOpt);
    if (!bmr::writePng(wr->readback(), out)) {
      std::fprintf(stderr, "bmshot: cannot write %s\n", out.c_str());
      return kFailure;
    }
    if (stats) {
      std::printf("{\"world\":true,\"size\":\"%dx%d\",\"triangles\":%llu,\"meshes\":%u,\"textures\":%u,\"loadMs\":%.1f,\"frames\":%d,\"cpuMs\":%.3f,\"gpuMs\":%.3f,\"drawCalls\":%u}\n",
                  width, height, static_cast<unsigned long long>(wr->triangleCount()), wr->meshCount(), wr->textureCount(),
                  loadMs, draws, s.cpuMs, s.gpuMs, s.drawCalls);
    }
    return kOk;
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
    Model model = columns * rows > 1 ? bmr::repeated(loaded, full, columns, rows, 80) : loaded;
    // Planned before anything is drawn when it changes what is drawn (--correct), or a frame is asked for.
    std::optional<bmtools::Planned> planned;
    if (frame >= 0 || shot.correct || shot.strip > 0) {
      bm::plan::Options planOptions;
      planOptions.correctPlacements = shot.correct;
      planned = bmtools::planModel(model, library, full, ldraw, planOptions, bmtools::styleWith(input, shot), double(width) / height);
      bmtools::reportCorrections("bmshot", model, planned->corrections);
    }
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
    if (benchFrames > 0 && frame < 0) return bench(*renderer, model, benchFrames, width, height, options);
    const double aspect = double(width) / height;
    bmr::OrbitCamera orbit;
    if (!bmtools::shotCamera(shot, renderer->scene().bounds, nullptr, orbit)) return usage();
    // At a frame of the build with no camera given, the director's camera.
    auto cameraAt = [&](int f) {
      bmr::Camera c = shot.directorFilms() ? bmtools::toCamera(film::cameraAt(planned->track, f), aspect, renderer->scene().bounds) : orbit.camera(aspect, renderer->scene().bounds);
      if (std::isfinite(shot.fovDegrees)) c.fovY = shot.fovDegrees * M_PI / 180;
      return c;
    };
    if (shot.strip > 0) {
      // A contact sheet: N frames from the first to the last, in reading order.
      const plan::Timeline& played = planned->timeline;
      const int n = shot.strip, across = static_cast<int>(std::ceil(std::sqrt(double(n)))), down = (n + across - 1) / across;
      bmr::Image sheet;
      sheet.width = across * width, sheet.height = down * height;
      sheet.rgba.assign(static_cast<size_t>(sheet.width) * static_cast<size_t>(sheet.height) * 4, 255);
      for (int k = 0; k < n; k++) {
        const int f = n == 1 ? 0 : static_cast<int>(std::lround(double(k) * played.frames / (n - 1)));
        renderer->setFrame(planned->plan, played, f);
        if (!shot.directorFilms()) bmtools::shotCamera(shot, renderer->scene().bounds, nullptr, orbit);
        renderer->draw(cameraAt(f), options);
        const bmr::Image cell = renderer->readback();
        for (int y = 0; y < cell.height && y < height; y++)
          std::copy_n(cell.rgba.begin() + static_cast<long>(y) * cell.width * 4, std::min(cell.width, width) * 4,
                      sheet.rgba.begin() + ((static_cast<long>(k / across) * height + y) * sheet.width + static_cast<long>(k % across) * width) * 4);
      }
      std::fprintf(stderr, "bmshot: %d frames of %d\n", n, played.frames);
      if (!bmr::writePng(sheet, out)) {
        std::fprintf(stderr, "bmshot: cannot write %s\n", out.c_str());
        return kFailure;
      }
      return kOk;
    }
    plan::Plan plan;
    plan::Timeline timeline;
    if (frame >= 0) {
      plan = std::move(planned->plan), timeline = std::move(planned->timeline);
      renderer->setFrame(plan, timeline, frame);
      bmtools::shotCamera(shot, renderer->scene().bounds, &timeline, orbit);
      std::fprintf(stderr, "bmshot: frame %d of %d\n", frame, timeline.frames);
      if (benchFrames > 0) return bench(*renderer, model, benchFrames, width, height, options, &plan, &timeline, frame);
    }
    bmr::FrameStats s;
    const int draws = options.realtimePathTrace ? std::max(1, rtptFrames) : 1;
    for (int d = 0; d < draws; d++) s = renderer->draw(cameraAt(frame), options);
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
