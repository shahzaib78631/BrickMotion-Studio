#pragma once
// A renderer over a small model written as LDraw text, kept alive for a test, with the
// framing camera. For tests that draw more than once.
#include <memory>
#include <string>
#include <utility>
#include "bm/math.h"
#include "bmr/camera.h"
#include "bmr/renderer.h"
#include "helpers.h"

namespace bmtest {

struct GpuRig {
  bm::ldraw::Library lib = fixtureLibrary();
  bm::ldraw::PartCache full{lib, cacheDir()};
  bm::ldraw::PartCache low{lib, cacheDir() / "low", lowOptions()};
  bm::Model model;
  std::unique_ptr<bmr::Renderer> renderer;
  bmr::Camera camera;
  int width, height;

  GpuRig(const std::string& text, int w = 256, int h = 256, double azimuth = 0.6, double elevation = 0.45) : model(modelFrom(text, lib)), width(w), height(h) {
    renderer = bmr::Renderer::create(model, full, low);
    if (!renderer) return;
    renderer->resize(w, h);
    bmr::OrbitCamera o = bmr::OrbitCamera::framing(renderer->scene().bounds, 0.6, double(w) / h);
    o.azimuth = azimuth, o.elevation = elevation;
    camera = o.camera(double(w) / h, renderer->scene().bounds);
  }
  static bm::ldraw::FlattenOptions lowOptions() {
    bm::ldraw::FlattenOptions o;
    o.lowResPrimitives = true;
    return o;
  }
  bmr::Image shot(const bmr::FrameOptions& options) {
    renderer->draw(camera, options);
    return renderer->readback();
  }
  /// Where a world point lands in the picture.
  std::pair<int, int> pixel(bm::Vec3 p) const {
    float clip[4];
    bmr::transform(bmr::multiply(bmr::projectionMatrix(camera), bmr::viewMatrix(camera, renderer->scene().origin)), p - renderer->scene().origin, clip);
    return {static_cast<int>(std::lround((clip[0] / clip[3] + 1) / 2 * width)), static_cast<int>(std::lround((1 - clip[1] / clip[3]) / 2 * height))};
  }
};

inline bmr::FrameOptions plainOptions() {
  bmr::FrameOptions o;
  o.edges = o.shadows = o.ambientOcclusion = o.floor = false;
  return o;
}

}  // namespace bmtest
