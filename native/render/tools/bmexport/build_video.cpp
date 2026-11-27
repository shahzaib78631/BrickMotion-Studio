#include <cerrno>
#include <charconv>
#include <cstdio>
#include <limits>
#include <system_error>
#include <sys/stdio.h>
#include <unistd.h>
#include "bm/doc/source.h"
#include "bmr/renderer.h"
#include "build_video.h"
#include "engine.h"
#include "movie_encoder.h"
#include "shot_options.h"

namespace bmtools {
namespace {

// The native save panel already chose a file. The helper stages independently for CLI
// callers as well, and commits without replacing an existing file.
class MovieOutput {
 public:
  explicit MovieOutput(std::filesystem::path output) : destination_(std::filesystem::absolute(std::move(output))) {
    std::string pattern = (destination_.parent_path() / ".brickmotion-video.XXXXXX").string();
    if (!mkdtemp(pattern.data())) throw std::system_error(errno, std::generic_category(), "Cannot create export staging directory");
    directory_ = std::move(pattern);
  }

  MovieOutput(const MovieOutput&) = delete;
  MovieOutput& operator=(const MovieOutput&) = delete;

  ~MovieOutput() {
    std::error_code ignored;
    std::filesystem::remove_all(directory_, ignored);
  }

  std::filesystem::path temporary() const { return directory_ / "Build.mp4"; }

  void commit() const {
    if (renamex_np(temporary().c_str(), destination_.c_str(), RENAME_EXCL) != 0)
      throw std::system_error(errno, std::generic_category(), "Cannot save video");
  }

 private:
  std::filesystem::path destination_, directory_;
};

int usage() {
  std::fprintf(stderr, "usage: bmexport build-video <project> --out <mp4> [--size WxH] [--fps 24|25|30|50|60] [--model name] [--azimuth a --elevation e]\n");
  return 2;
}

}  // namespace

int buildVideo(const std::vector<std::string_view>& args) {
  if (args.size() < 2 || args[1].starts_with("--")) return usage();
  const std::filesystem::path input{args[1]};
  ShotOptions shot;
  shot.frame = 0, shot.width = 1920, shot.height = 1080;
  int fps = 30;
  std::string modelName;
  for (size_t i = 2; i < args.size(); ++i) {
    if (args[i] == "--fps") {
      if (++i == args.size()) return usage();
      const auto value = args[i];
      auto parsed = std::from_chars(value.data(), value.data() + value.size(), fps);
      if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) return usage();
    } else if (args[i] == "--model") {
      if (++i == args.size() || args[i].empty()) return usage();
      modelName = args[i];
    } else if (args[i] == "--size" || args[i] == "--out" || args[i] == "--azimuth" || args[i] == "--elevation") {
      if (parseShotOption(shot, args, i) != 1) return usage();
    } else {
      return usage();
    }
  }
  if (shot.out.empty() || shot.width % 2 || shot.height % 2 || shot.width > 3840 || shot.height > 3840 ||
      (fps != 24 && fps != 25 && fps != 30 && fps != 50 && fps != 60)) return usage();

  try {
    if (std::filesystem::exists(shot.out)) throw std::runtime_error("The output file already exists.");
    const std::string ldraw = ldrawDir();
    if (ldraw.empty()) throw std::runtime_error("Choose an LDraw parts library before exporting.");
    const bm::ldraw::Library library(ldraw);
    bm::ldraw::PartCache full(library, bm::ldraw::PartCache::defaultDirectory());
    bm::ldraw::FlattenOptions lowOptions;
    lowOptions.lowResPrimitives = true;
    bm::ldraw::PartCache low(library, bm::ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", lowOptions);
    auto model = [&] {
      if (modelName.empty()) return bm::io::load(input, library, &full);
      const auto source = bm::doc::fromFile(input);
      if (!source.def(modelName)) throw std::runtime_error("The selected model could not be found in the export snapshot.");
      return bm::doc::flatten(source, library, full, modelName).model;
    }();
    if (model.pieces().empty()) throw std::runtime_error("The selected model has no parts.");

    auto style = bm::plan::styleOf(input);
    const double aspect = static_cast<double>(shot.width) / shot.height;
    const auto planned = planModel(model, library, full, ldraw, {}, style, aspect);
    if (planned.timeline.frames < 1) throw std::runtime_error("The planner could not produce a build video for this model.");
    const double duration = static_cast<double>(planned.timeline.frames) / style.fps;
    if (duration * fps >= std::numeric_limits<int>::max()) throw std::runtime_error("The build is too long to encode.");
    const int frames = std::max(2, static_cast<int>(std::lround(duration * fps)));

    auto renderer = bmr::Renderer::create(model, full, low, shot.rounding);
    if (!renderer) throw std::runtime_error("Metal could not start the video renderer.");
    renderer->resize(shot.width, shot.height);
    const bm::Box bounds = renderer->scene().bounds;
    bmr::OrbitCamera orbit;
    if (!shotCamera(shot, bounds, nullptr, orbit)) throw std::runtime_error("The camera could not frame this model.");
    const auto fixedCamera = orbit.camera(aspect, bounds);
    const auto draw = [&](int index) {
      const double frame = static_cast<double>(index) * planned.timeline.frames / (frames - 1);
      renderer->setFrame(planned.plan, planned.timeline, frame);
      const auto camera = shot.directorFilms() && !planned.track.frames.empty()
          ? toCamera(bm::film::cameraAt(planned.track, frame), aspect, bounds) : fixedCamera;
      if (!renderer->draw(camera).submitted) throw std::runtime_error("Metal could not draw a video frame.");
      return renderer->readback();
    };
    const MovieOutput output(shot.out);
    encodeMovie(output.temporary(), shot.width, shot.height, fps, frames, draw);
    output.commit();
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "bmexport: %s\n", error.what());
    return 1;
  }
}

}  // namespace bmtools
