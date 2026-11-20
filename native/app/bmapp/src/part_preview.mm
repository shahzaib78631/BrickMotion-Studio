#import <Foundation/Foundation.h>

#include "bmapp/part_preview.h"
#include "bm/doc/source.h"
#include "bmr/renderer.h"

namespace bmapp {
namespace {

constexpr int kSize = 224;
constexpr int kPartsPerRenderer = 32;
constexpr int kProjectWidth = 256;
constexpr int kProjectHeight = 160;

Picture picture(bmr::Image image) { return {image.width, image.height, std::move(image.rgba)}; }

void cacheImage(const bmr::Image& image, const std::filesystem::path& path) {
  std::error_code ec;
  std::filesystem::create_directories(path.parent_path(), ec);
  if (ec) return;
  auto temporary = path;
  temporary += std::string(".") + NSUUID.UUID.UUIDString.UTF8String;
  if (bmr::writePng(image, temporary)) std::filesystem::rename(temporary, path, ec);
  std::filesystem::remove(temporary, ec);
}

}  // namespace

struct PartPreview::Impl {
  bm::ldraw::Library library;
  std::filesystem::path images;
  std::filesystem::path projects;
  std::unique_ptr<bm::ldraw::PartCache> parts;
  std::unique_ptr<bm::Model> model;
  std::unique_ptr<bmr::Renderer> renderer;
  int requests = 0;

  explicit Impl(const std::string& ldraw)
    : library(ldraw), images(bm::ldraw::PartCache::defaultDirectory().parent_path() / "part-previews-v2" /
                            std::to_string(std::hash<std::string>{}(ldraw))),
      projects(images.parent_path().parent_path() / "project-previews-v1" / images.filename()) {}

  void reset() {
    renderer.reset();
    model.reset();
    parts = std::make_unique<bm::ldraw::PartCache>(library, bm::ldraw::PartCache::defaultDirectory());
    requests = 0;
  }
};

static bmr::FrameOptions previewOptions(bool dark) {
  bmr::FrameOptions options;
  options.floor = options.shadows = options.ambientOcclusion = false;
  options.forceDetail = 0;
  options.lightsFollowCamera = true;
  const float level = dark ? 0.044f : 0.83f;
  options.background[0] = level * 0.93f;
  options.background[1] = level * 0.97f;
  options.background[2] = level;
  return options;
}

PartPreview* PartPreview::create(const std::string& ldraw) { return new PartPreview(ldraw); }
PartPreview::PartPreview(const std::string& ldraw) : impl_(std::make_unique<Impl>(ldraw)) {}
PartPreview::~PartPreview() = default;

Picture PartPreview::render(const std::string& part, int color, bool dark) {
  @autoreleasepool {
    // Catalogue entries are top-level names. Keep the cache path inside its library folder.
    if (part.empty() || std::filesystem::path(part).filename() != part || !part.ends_with(".dat")) return {};
    auto& state = *impl_;
    if (!state.parts || state.requests >= kPartsPerRenderer) state.reset();
    ++state.requests;
    const auto mesh = state.parts->get(part);
    if (mesh->triangles.empty()) return {};
    const auto path = state.images / (part + "-" + std::to_string(mesh->sourceHash) + "-" +
      std::to_string(state.library.stamp("LDConfig.ldr")) + "-" + std::to_string(color) + (dark ? "-dark.png" : "-light.png"));
    auto saved = bmr::readPng(path);
    if (saved.width == kSize && saved.height == kSize && !saved.empty()) return picture(std::move(saved));

    bm::Model::Data data{{}, {}, {}, state.library, {}};
    data.pieces.push_back({.id = "preview", .part = part, .color = color, .world = {}, .step = 0, .path = {}, .steps = {}});
    auto model = std::make_unique<bm::Model>(std::move(data));
    if (state.renderer) {
      state.renderer->modelChanged(*model);
    } else {
      // Every tile uses Full, so both cache inputs can use the same geometry.
      state.renderer = bmr::Renderer::create(*model, *state.parts, *state.parts);
      if (!state.renderer) return {};
      state.renderer->resize(kSize, kSize);
    }
    state.model = std::move(model);

    const auto& bounds = state.renderer->scene().bounds;
    const auto orbit = bmr::OrbitCamera::fitted(bounds, 0.45, 1, 0.72, 0.55);
    if (!state.renderer->draw(orbit.camera(1, bounds), previewOptions(dark)).submitted) return {};
    auto image = state.renderer->readback();
    if (image.empty()) return {};
    cacheImage(image, path);
    return picture(std::move(image));
  }
}

Picture PartPreview::renderModel(const std::string& file, bool dark) {
  @autoreleasepool {
    auto& state = *impl_;
    const std::filesystem::path source(file);
    std::error_code error;
    const auto size = std::filesystem::file_size(source, error);
    if (error) return {};
    const auto modified = static_cast<int64_t>(std::filesystem::last_write_time(source, error).time_since_epoch().count());
    if (error) return {};
    const auto cached = state.projects / (std::to_string(std::hash<std::string>{}(file)) + "-" +
      std::to_string(size) + "-" + std::to_string(modified) + (dark ? "-dark.png" : "-light.png"));
    auto saved = bmr::readPng(cached);
    if (saved.width == kProjectWidth && saved.height == kProjectHeight && !saved.empty()) return picture(std::move(saved));
    try {
      if (!state.parts || state.requests >= kPartsPerRenderer) state.reset();
      ++state.requests;
      auto document = bm::doc::fromFile(source);
      auto flat = bm::doc::flatten(document, state.library, *state.parts);
      auto renderer = bmr::Renderer::create(flat.model, *state.parts, *state.parts);
      if (!renderer || renderer->scene().bounds.empty()) return {};
      renderer->resize(kProjectWidth, kProjectHeight);
      constexpr double aspect = static_cast<double>(kProjectWidth) / kProjectHeight;
      const auto& bounds = renderer->scene().bounds;
      const auto orbit = bmr::OrbitCamera::fitted(bounds, 0.6, aspect, 0.56, 0.40);
      auto options = previewOptions(dark);
      options.forceDetail = -1;
      if (!renderer->draw(orbit.camera(aspect, bounds), options).submitted) return {};
      auto image = renderer->readback();
      if (image.empty()) return {};
      cacheImage(image, cached);
      return picture(std::move(image));
    } catch (const std::exception&) {
      return {};
    }
  }
}

}  // namespace bmapp

void bmappRetainPartPreview(bmapp::PartPreview* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleasePartPreview(bmapp::PartPreview* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
