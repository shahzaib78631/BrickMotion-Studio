// No Catch2/JSON/Metal required: portable, deterministic regression checks for
// Studio custom geometry -> shape -> broad phase -> sweep -> planner travel.
// Build with the core sources listed in tools/perf/studio_collision_verify.sh.
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_set>
#include <string>
#include "bm/collide/geometry_audit.h"
#include "bm/collide/world.h"
#include "bm/io.h"
#include "bm/plan/certify.h"

namespace bm::io {
// This function is internal to ldraw_io.cpp, but the standalone portability
// build avoids the full native JSON/ObjC++ build by reusing it directly.
Model modelFromLDraw(std::string_view, const std::string&, const ldraw::Library&,
                     std::vector<ldraw::File>, size_t);
}

namespace fs = std::filesystem;
using namespace bm;

static void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

static std::string read(const fs::path& file) {
  std::ifstream stream(file, std::ios::binary);
  if (!stream) throw std::runtime_error("cannot open " + file.string());
  std::ostringstream out;
  out << stream.rdbuf();
  return out.str();
}

static Model loadStudio(const fs::path& path, const ldraw::Library& library) {
  auto arc = io::readStudioArchive(read(path));
  return io::modelFromLDraw(arc.model, "model.ldr", library,
                            std::move(arc.customParts), arc.availableCustomParts);
}

static Xform at(double x) { return {Mat3::identity(), {x, 0, 0}}; }

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: studio_collision_verify <ldraw-library> <studio-fixture-dir> [real-model.mpd/.io ...]\n";
    return 2;
  }
  try {
    const ldraw::Library library(argv[1]);
    ldraw::PartCache cache(library, fs::temp_directory_path() / "bm_custom_collision_verify_cache");
    collide::ShapeCache shapes;
    const fs::path dir = argv[2];
    const Model good = loadStudio(dir / "collision_clear.io", library);
    const auto audit = collide::auditGeometry(good, cache, shapes);
    require(good.pieces().size() == 2, "fixture expansion changed");
    require(good.report().studioCustomPartsLoaded == 2, "custom geometry not imported");
    require(audit.structurallyComplete(), "good custom geometry is incomplete");
    require(audit.instantiatedTriangles == 24, "unexpected triangle geometry");
    // Shape and mesh caches are shared by planner workers. Confirm that
    // concurrent first use returns one canonical object per model-scoped part.
    constexpr size_t workers = 8;
    std::vector<std::shared_ptr<const ldraw::Mesh>> concurrentMeshes(workers);
    std::vector<std::shared_ptr<const collide::Shape>> concurrentShapes(workers);
    std::vector<std::thread> threads;
    for (size_t i = 0; i < workers; ++i)
      threads.emplace_back([&, i] {
        concurrentMeshes[i] = good.mesh("validation-cube.dat", cache);
        concurrentShapes[i] = shapes.get(concurrentMeshes[i]);
      });
    for (auto& t : threads) t.join();
    for (size_t i = 1; i < workers; ++i)
      require(concurrentMeshes[i] == concurrentMeshes[0] && concurrentShapes[i] == concurrentShapes[0],
              "concurrent custom geometry cache access did not reuse immutable shapes");

    const collide::World world(good, cache, shapes);
    require(!world.shape(0).nodes.empty(), "custom shape is empty");
    require(!world.hits(world.shape(0), at(60)), "clear pose collides");
    require(world.hits(world.shape(0), at(30)) == std::optional<uint32_t>{0}, "penetrating pose is not detected");
    const auto sweep = world.sweep(world.shape(0), at(-160), at(60));
    require(sweep && *sweep > 0.4 && *sweep < 0.8, "continuous path missed collision");
    uint32_t blocker = UINT32_MAX;
    const double travel = world.clearTravel({1}, {-1, 0, 0}, 120, nullptr, {}, &blocker);
    require(travel > 75 && travel < 85 && blocker == 0, "planner travel did not stop at custom part");

    connect::Graph certificationGraph;
    certificationGraph.groups = 2;
    certificationGraph.group = {0, 1};
    certificationGraph.isSegment = {0, 0};
    plan::Plan safe;
    plan::Move one, two;
    one.unit.pieces = {0};
    one.path = {Xform::identity(), at(-280)};
    two.unit.pieces = {1};
    two.path = {Xform::identity(), at(280)};
    safe.moves = {one, two};
    const auto accepted = plan::certify(good, certificationGraph, cache, shapes, safe);
    require(accepted.ok() && accepted.certified == 2, "safe plan was rejected");
    auto unsafe = safe;
    unsafe.moves[1].path[1] = at(-280);
    const auto rejected = plan::certify(good, certificationGraph, cache, shapes, unsafe);
    require(!rejected.ok() && rejected.crossings == 1 && !rejected.moves[1].clear &&
                rejected.moves[1].crossed == 0,
            "independent plan certifier allowed travel through an embedded custom part");

    const Model overlapping = loadStudio(dir / "collision_overlap.io", library);
    connect::Graph graph;
    graph.isSegment.resize(overlapping.pieces().size());
    const auto report = collide::findOverlaps(overlapping, graph, cache, shapes);
    require(report.tested == 1 && report.overlaps.size() == 1 && !report.overlaps[0].duplicate,
            "custom parts were not reported overlapping");

    const Model partial = loadStudio(dir / "collision_partial.io", library);
    const auto bad = collide::auditGeometry(partial, cache, shapes);
    require(!bad.structurallyComplete() && bad.partsWithMissingDependencies == 1 &&
                bad.partsWithoutCollisionShapes == 0 && bad.issues.size() == 1 &&
                bad.issues[0].missing == std::vector<std::string>{"missing-nested-part.dat"},
            "partially missing geometry was silently accepted");
    const Model malformed = loadStudio(dir / "collision_malformed.io", library);
    require(malformed.report().studioCustomPartSkippedLines == 1, "malformed custom commands were not reported");
    require(!collide::auditGeometry(malformed, cache, shapes).structurallyComplete(),
            "malformed custom geometry passed structural validation");
    std::cout << "PASS: import, nested mesh, complete audit, overlap, static hit, sweep, clearTravel,"
                 " independent plan certification, thread-safe mesh/shape reuse, and strict geometry diagnostics\n";
    std::cout << "custom triangle instances=" << audit.instantiatedTriangles
              << ", clear travel=" << travel << ", first sweep hit=" << *sweep << "\n";

    // Optional real-world smoke pass. Unlike the hand-crafted fixtures, a
    // full model can have missing *standard* LDraw parts when tested against
    // the intentionally tiny fixture library. Report that honestly, and check
    // only that imported *placed* custom parts produced collision shapes.
    for (int arg = 3; arg < argc; ++arg) {
      const auto started = std::chrono::steady_clock::now();
      const fs::path path(argv[arg]);
      const bool studio = path.extension() == ".io";
      const Model model = studio ? loadStudio(path, library)
          : io::modelFromLDraw(read(path), path.filename().string(), library, {}, 0);
      const auto realAudit = collide::auditGeometry(model, cache, shapes);
      const collide::World realWorld(model, cache, shapes);
      std::unordered_set<std::string> placedCustom;
      size_t customWithoutShape = 0;
      for (uint32_t i = 0; i < model.pieces().size(); ++i) {
        if (!model.library().isInline(model.pieces()[i].part)) continue;
        placedCustom.insert(model.pieces()[i].part);
        if (realWorld.shape(i).nodes.empty()) ++customWithoutShape;
      }
      const double ms = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - started).count();
      std::cout << "MODEL " << argv[arg] << ": pieces=" << model.pieces().size()
                << " distinct=" << realAudit.distinctParts
                << " embeddedLoaded=" << model.report().studioCustomPartsLoaded
                << " customPlacedTypes=" << placedCustom.size()
                << " customMissingShapes=" << customWithoutShape
                << " incompleteTypes=" << realAudit.partsWithMissingDependencies
                << " noShapeTypes=" << realAudit.partsWithoutCollisionShapes
                << " elapsedMs=" << ms << "\n";
      // Studio files should have valid placed custom shapes in the supplied
      // verified fixtures. Arbitrary MPDs may contain intentional line-only
      // inline definitions; report them without incorrectly failing the run.
      if (studio)
        require(customWithoutShape == 0, "real Studio model has placed custom parts without collision shapes");
    }
  } catch (const std::exception& e) {
    std::cerr << "FAIL: " << e.what() << '\n';
    return 1;
  }
  return 0;
}
