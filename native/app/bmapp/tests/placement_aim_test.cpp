// How placement feels from the viewport: a pointer swept over a part, and a pointer on each of
// its free connectors. Red (blocked) previews over a part should be rare, and pointing at a
// compatible connector the camera sees should seat the part on it.
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <thread>
#include "bm/connect/mate.h"
#include "bmapp/assembly_inspection.h"
#include "bmapp/gizmo.h"
#include "bmapp/viewport.h"
#include "engine.h"
#include "placement_solver.h"
#include "session_impl.h"

namespace {

using bm::connect::Connector, bm::connect::Gender, bm::connect::SnapKind;

struct Pair { const char* part; const char* target; const char* label; };

const std::vector<Pair> kPairs = {
  {"3001.dat", "3001.dat", "brick on brick"},
  {"3023b.dat", "3001.dat", "plate on brick"},
  {"3069b.dat", "3001.dat", "tile on brick"},
  {"3062b.dat", "3001.dat", "round 1x1 on brick"},
  {"2780.dat", "3700.dat", "pin into technic brick"},
  {"3673.dat", "32523.dat", "pin into beam"},
  {"4519.dat", "32523.dat", "axle into beam"},
  {"4519.dat", "6536.dat", "axle into cross block"},
  {"3713.dat", "3705.dat", "bush onto axle"},
  {"3648b.dat", "3705.dat", "gear onto axle"},
  {"32523.dat", "2780.dat", "beam onto pin"},
  {"3938.dat", "3937.dat", "hinge top on base"},
  {"4085c.dat", "30374.dat", "clip onto bar"},
  {"87087.dat", "3001.dat", "SNOT brick on brick"},
  {"3001.dat", "87087.dat", "brick onto side stud"},
};

bool compatible(const Connector& a, const Connector& b) {
  if (a.kind == b.kind) return a.kind == SnapKind::Generic || a.gender != b.gender;
  return (a.kind == SnapKind::Cyl && a.gender == Gender::Male && b.kind == SnapKind::Clip) ||
         (b.kind == SnapKind::Cyl && b.gender == Gender::Male && a.kind == SnapKind::Clip);
}

bmapp::PlacementPreview await(bmapp::Viewport& v, uint64_t id) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (std::chrono::steady_clock::now() < deadline) {
    v.draw(nullptr);
    const auto p = v.placementPreview();
    if (p.request >= id) return p;
    std::this_thread::sleep_for(std::chrono::microseconds(300));
  }
  return {};
}

struct Score { int over = 0, red = 0, aimed = 0, seated = 0; std::vector<std::string> misses; };

enum class View { Default, Orbited, Orthographic };

Score measure(const Pair& pair, View view, bool verbose) {
  Score score;
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart(pair.target, 4, {}, 0, session.generation(), session.version()).refused.empty());
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) return score;
  const double W = 900, H = 600;
  viewport.resize(W, H, 1);
  if (view == View::Orbited) viewport.orbit(260, -120);
  if (view == View::Orthographic) viewport.setOrthographic(true);
  viewport.fitAll();
  viewport.zoom(0.6);
  viewport.draw(nullptr);
  const auto camera = viewport.camera();
  if (verbose) std::fprintf(stderr, "  camera yaw %.2f pitch %.2f distance %.0f ortho %d\n", camera.yaw, camera.pitch, camera.distance, camera.orthographic);
  const auto eye = bmapp::handleAxis(camera, {}, bmapp::Handle::View);
  const bm::Vec3 toEye{eye.x, eye.y, eye.z};
  auto& impl = session.impl();
  const auto& piece = impl.model->pieces()[0];
  bmapp::PlacementInput input;
  input.part = pair.part;

  // A sweep over the part: how often does the preview turn red?
  const auto box = impl.model->mesh(piece.part, *impl.full)->bounds.transformed(piece.world);
  double x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (int c = 0; c < 8; ++c) {
    const bmapp::Vec3 p{c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z};
    const auto s = bmapp::projectPoint(camera, {W, H}, p);
    x0 = std::min(x0, s.x), x1 = std::max(x1, s.x), y0 = std::min(y0, s.y), y1 = std::max(y1, s.y);
  }
  const int N = 12;
  for (int i = 0; i < N; ++i)
    for (int j = 0; j < N; ++j) {
      const bmapp::Vec2 at{x0 + (x1 - x0) * (i + 0.5) / N, y0 + (y1 - y0) * (j + 0.5) / N};
      if (viewport.pick(at.x, at.y) != 0) continue;
      ++score.over;
      const auto preview = await(viewport, viewport.previewPart(input, at));
      if (preview.state == bmapp::PlacementState::Blocked) {
        ++score.red;
        if (verbose) std::fprintf(stderr, "    red at (%.0f, %.0f): %s\n", at.x, at.y, preview.reason.c_str());
      }
    }

  // A pointer on each visible connector the part can take.
  bmtools::ConnectorSources sources(*impl.library, impl.ldraw);
  const auto mine = sources.connectors.get(pair.part, &impl.model->library());
  const auto theirs = sources.connectors.get(piece.part, &impl.model->library());
  bm::collide::ShapeCache shapes;
  bmapp::PlacementSolver solver(*impl.model, *impl.full, sources.connectors, shapes);
  const auto mates = [&](const bmapp::PartPose& p, const Connector& target) {
    bm::Xform pose;
    std::copy_n(p.rotation.m, 9, pose.r.m);
    pose.t = {p.position.x, p.position.y, p.position.z};
    return std::any_of(mine->begin(), mine->end(), [&](const Connector& c) { return bool(bm::connect::mate(bm::connect::transformed(c, pose), target)); });
  };
  for (size_t k = 0; k < theirs->size(); ++k) {
    const Connector target = bm::connect::transformed((*theirs)[k], piece.world);
    if (std::none_of(mine->begin(), mine->end(), [&](const Connector& c) { return compatible(c, target); })) continue;
    // Only connectors the part really seats on, clear of the target, count.
    bool seatable = false;
    {
      const bmapp::PlacementRequest request{.part = pair.part, .point = target.start, .reach = 40, .onlyTarget = 0u};
      for (const bm::Vec3 at : {target.start, target.start + target.axis * target.length}) {
        auto r = request;
        r.point = at;
        const auto placed = solver.solve(r);
        if (placed && std::holds_alternative<bmapp::PlacedOnConnector>(*placed)) {
          const auto& on = std::get<bmapp::PlacedOnConnector>(*placed);
          bmapp::PartPose p;
          std::copy_n(on.pose.r.m, 9, p.rotation.m);
          p.position = {on.pose.t.x, on.pose.t.y, on.pose.t.z};
          if (mates(p, target)) seatable = true;
        }
      }
    }
    if (!seatable) continue;
    const bool shortOne = target.kind == SnapKind::Cyl && target.length <= 8;
    struct Mouth { bm::Vec3 at, outward; };
    std::vector<Mouth> mouths;
    if (target.kind != SnapKind::Cyl) mouths.push_back({target.start + target.axis * (target.length * 0.5), toEye});
    else if (shortOne) mouths.push_back({target.start, target.gender == Gender::Male ? target.axis : -target.axis});
    else {
      if (target.gender == Gender::Male || target.openStart) mouths.push_back({target.start, -target.axis});
      if (target.gender == Gender::Male || target.openEnd) mouths.push_back({target.start + target.axis * target.length, target.axis});
    }
    for (const auto& mouth : mouths) {
      if (bm::dot(mouth.outward, toEye) < 0.25) continue;
      const auto s = bmapp::projectPoint(camera, {W, H}, {mouth.at.x, mouth.at.y, mouth.at.z});
      if (!(s.x > 2 && s.y > 2 && s.x < W - 2 && s.y < H - 2) || viewport.pick(s.x, s.y) != 0) continue;
      ++score.aimed;
      const auto preview = await(viewport, viewport.previewPart(input, s));
      const bool seated = preview.state == bmapp::PlacementState::Snapped && mates(preview.pose, target);
      if (seated) ++score.seated;
      else {
        char line[200];
        std::snprintf(line, sizeof line, "connector %zu at (%.0f %.0f %.0f) -> state %d %s pose (%.0f %.0f %.0f) contact (%.0f %.0f %.0f)", k,
                      mouth.at.x, mouth.at.y, mouth.at.z, int(preview.state), preview.reason.c_str(), preview.pose.position.x,
                      preview.pose.position.y, preview.pose.position.z, preview.contact.x, preview.contact.y, preview.contact.z);
        score.misses.push_back(line);
      }
    }
  }
  return score;
}

}  // namespace

TEST_CASE("aimed placement: few red previews, and a pointed-at connector seats the part", "[bmapp][placement][aim]") {
  const bool verbose = std::getenv("AIM_VERBOSE") != nullptr;
  const char* only = std::getenv("AIM_ONLY");
  int over = 0, red = 0, aimed = 0, seated = 0;
  for (const View view : {View::Default, View::Orbited, View::Orthographic}) {
    for (const auto& pair : kPairs) {
      if (only && std::string(pair.label).find(only) == std::string::npos) continue;
      const auto s = measure(pair, view, verbose);
      over += s.over, red += s.red, aimed += s.aimed, seated += s.seated;
      std::fprintf(stderr, "view %d  %-24s red %3d/%-3d  seated %2d/%-2d\n", int(view), pair.label, s.red, s.over, s.seated, s.aimed);
      if (verbose)
        for (const auto& m : s.misses) std::fprintf(stderr, "    miss %s\n", m.c_str());
      // Each pair on its own: no part is mostly red, and most of its aimed connectors seat.
      CHECK(s.red <= s.over / 5);
      CHECK(s.seated * 4 >= s.aimed * 3);
    }
  }
  if (over == 0) SKIP("no Metal device");
  std::fprintf(stderr, "total red %d/%d (%.1f%%), seated %d/%d (%.1f%%)\n", red, over, 100.0 * red / over, seated, aimed,
               aimed ? 100.0 * seated / aimed : 0.0);
  // Thresholds fixed before the change (2026-11-22): at most 5% red, at least 90% seated.
  CHECK(red * 20 <= over);
  CHECK(seated * 10 >= aimed * 9);
}

namespace {

/// A small build: a base brick, a brick across half of it, a Technic brick beside with a pin in
/// one side. Every visible free connector of every piece is aimed at, placing a new part or
/// dragging the loose brick (piece 3).
Score crowded(const char* part, View view, bool drag, bool verbose) {
  Score score;
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  const auto place = [&](const char* p, bmapp::PartPose pose) {
    REQUIRE(session.placePart(p, 4, pose, 0, session.generation(), session.version()).refused.empty());
  };
  place("3001.dat", {});
  place("3001.dat", {{}, {40, -24, 0}});
  place("3700.dat", {{}, {-80, 0, 0}});
  place("2780.dat", {{{0, 0, 1, 0, 1, 0, -1, 0, 0}}, {-80, 10, -20}});
  if (drag) place(part, {{}, {0, 0, 120}});
  bmapp::Viewport viewport(session);
  if (!viewport.ok()) return score;
  const double W = 900, H = 600;
  viewport.resize(W, H, 1);
  if (view == View::Orbited) viewport.orbit(260, -120);
  if (view == View::Orthographic) viewport.setOrthographic(true);
  viewport.fitAll();
  viewport.draw(nullptr);
  const auto camera = viewport.camera();
  const auto eye = bmapp::handleAxis(camera, {}, bmapp::Handle::View);
  const bm::Vec3 toEye{eye.x, eye.y, eye.z};
  auto& impl = session.impl();
  const uint32_t moving = drag ? 4 : UINT32_MAX;
  bmapp::PlacementInput input;
  input.part = part;
  if (drag) {
    const auto& grabbed = impl.model->pieces()[moving].world.t;
    const auto s = bmapp::projectPoint(camera, {W, H}, {grabbed.x, grabbed.y - 12, grabbed.z});
    input.anchor = moving;
    input.grab = s;
    input.selection = {moving};
  }
  bmtools::ConnectorSources sources(*impl.library, impl.ldraw);
  bm::collide::ShapeCache shapes;
  bmapp::PlacementSolver solver(*impl.model, *impl.full, sources.connectors, shapes);
  const auto mine = sources.connectors.get(part, &impl.model->library());
  const auto mates = [&](const bmapp::PartPose& p, const Connector& target) {
    bm::Xform pose;
    std::copy_n(p.rotation.m, 9, pose.r.m);
    pose.t = {p.position.x, p.position.y, p.position.z};
    return std::any_of(mine->begin(), mine->end(), [&](const Connector& c) { return bool(bm::connect::mate(bm::connect::transformed(c, pose), target)); });
  };
  const std::vector<uint32_t> excluded = drag ? std::vector<uint32_t>{moving} : std::vector<uint32_t>{};

  // Sweep the whole view: red only where nothing clean was near.
  for (int i = 0; i < 18; ++i)
    for (int j = 0; j < 12; ++j) {
      const bmapp::Vec2 at{W * (i + 0.5) / 18, H * (j + 0.5) / 12};
      const auto picked = viewport.pick(at.x, at.y);
      if (picked == UINT32_MAX || picked == moving) continue;
      ++score.over;
      const auto preview = await(viewport, viewport.previewPart(input, at));
      if (preview.state == bmapp::PlacementState::Blocked) {
        ++score.red;
        if (verbose) std::fprintf(stderr, "    red at (%.0f, %.0f) over %u: %s\n", at.x, at.y, picked, preview.reason.c_str());
      }
    }
  for (uint32_t piece = 0; piece < 4; ++piece) {
    const auto& placed = impl.model->pieces()[piece];
    const auto theirs = sources.connectors.get(placed.part, &impl.model->library());
    for (size_t k = 0; k < theirs->size(); ++k) {
      const Connector target = bm::connect::transformed((*theirs)[k], placed.world);
      if (std::none_of(mine->begin(), mine->end(), [&](const Connector& c) { return compatible(c, target); })) continue;
      bool seatable = false;
      for (const bm::Vec3 at : {target.start, target.start + target.axis * target.length}) {
        const bmapp::PlacementRequest request{.part = part, .point = at, .reach = 40, .moving = excluded, .onlyTarget = piece};
        const auto placedOn = solver.solve(request);
        if (placedOn && std::holds_alternative<bmapp::PlacedOnConnector>(*placedOn)) {
          const auto& on = std::get<bmapp::PlacedOnConnector>(*placedOn);
          bmapp::PartPose p;
          std::copy_n(on.pose.r.m, 9, p.rotation.m);
          p.position = {on.pose.t.x, on.pose.t.y, on.pose.t.z};
          if (mates(p, target)) seatable = true;
        }
      }
      if (!seatable) continue;
      const bool shortOne = target.kind == SnapKind::Cyl && target.length <= 8;
      struct Mouth { bm::Vec3 at, outward; };
      std::vector<Mouth> mouths;
      if (target.kind != SnapKind::Cyl) mouths.push_back({target.start + target.axis * (target.length * 0.5), toEye});
      else if (shortOne) mouths.push_back({target.start, target.gender == Gender::Male ? target.axis : -target.axis});
      else {
        if (target.gender == Gender::Male || target.openStart) mouths.push_back({target.start, -target.axis});
        if (target.gender == Gender::Male || target.openEnd) mouths.push_back({target.start + target.axis * target.length, target.axis});
      }
      for (const auto& mouth : mouths) {
        if (bm::dot(mouth.outward, toEye) < 0.25) continue;
        const auto s = bmapp::projectPoint(camera, {W, H}, {mouth.at.x, mouth.at.y, mouth.at.z});
        if (!(s.x > 2 && s.y > 2 && s.x < W - 2 && s.y < H - 2) || viewport.pick(s.x, s.y) != piece) continue;
        ++score.aimed;
        const auto preview = await(viewport, viewport.previewPart(input, s));
        if (preview.state == bmapp::PlacementState::Snapped && mates(preview.pose, target)) ++score.seated;
        else {
          char line[200];
          std::snprintf(line, sizeof line, "piece %u connector %zu at (%.0f %.0f %.0f) -> state %d %s pose (%.0f %.0f %.0f)", piece, k,
                        mouth.at.x, mouth.at.y, mouth.at.z, int(preview.state), preview.reason.c_str(), preview.pose.position.x,
                        preview.pose.position.y, preview.pose.position.z);
          score.misses.push_back(line);
        }
      }
    }
  }
  return score;
}

}  // namespace

TEST_CASE("aimed placement in a small build, for a new part and a dragged one", "[bmapp][placement][aim]") {
  const bool verbose = std::getenv("AIM_VERBOSE") != nullptr;
  int over = 0, red = 0, aimed = 0, seated = 0;
  for (const View view : {View::Default, View::Orbited, View::Orthographic})
    for (const bool drag : {false, true})
      for (const char* part : {"3001.dat", "3023b.dat", "3673.dat"}) {
        const auto s = crowded(part, view, drag, verbose);
        over += s.over, red += s.red, aimed += s.aimed, seated += s.seated;
        std::fprintf(stderr, "view %d %s %-10s red %3d/%-3d  seated %2d/%-2d\n", int(view), drag ? "drag" : "new ", part, s.red, s.over,
                     s.seated, s.aimed);
        if (verbose)
          for (const auto& m : s.misses) std::fprintf(stderr, "    miss %s\n", m.c_str());
      }
  if (over == 0) SKIP("no Metal device");
  std::fprintf(stderr, "build: red %d/%d (%.1f%%), seated %d/%d (%.1f%%)\n", red, over, 100.0 * red / over, seated, aimed,
               aimed ? 100.0 * seated / aimed : 0.0);
  CHECK(red * 20 <= over);
  CHECK(seated * 10 >= aimed * 9);
}

TEST_CASE("aimed placement timing on reference builds", "[.][aimbench]") {
  for (const char* file : {BM_REPO "/samples/helicopter/helicopter.mpd", BM_REPO "/public/data/omr/10030-1/10030-1.mpd"}) {
    bmapp::Session session;
    const auto opened = session.open(file);
    if (!opened.ok) continue;
    bmapp::Viewport viewport(session);
    if (!viewport.ok()) SKIP("no Metal device");
    viewport.resize(1440, 900, 1);
    viewport.fitAll();
    viewport.zoom(2.5);
    viewport.draw(nullptr);
    for (const char* part : {"3001.dat", "2780.dat"}) {
      bmapp::PlacementInput input;
      input.part = part;
      await(viewport, viewport.previewPart(input, {720, 450}));  // warm the worker's model
      std::vector<double> ms;
      std::map<int, int> states;
      for (int i = 0; i < 16; ++i)
        for (int j = 0; j < 10; ++j) {
          const auto t0 = std::chrono::steady_clock::now();
          const auto preview = await(viewport, viewport.previewPart(input, {1440.0 * (i + 0.5) / 16, 900.0 * (j + 0.5) / 10}));
          ms.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
          ++states[int(preview.state)];
        }
      std::sort(ms.begin(), ms.end());
      std::fprintf(stderr, "%s %s: %zu pieces, median %.1f ms, p95 %.1f ms, max %.1f ms; free %d snapped %d blocked %d\n",
                   std::strrchr(file, '/') + 1, part, session.pieceCount(), ms[ms.size() / 2], ms[ms.size() * 95 / 100], ms.back(),
                   states[2], states[3], states[5]);
    }
  }
}

TEST_CASE("Ways to Fit finds the joint for parts set apart", "[bmapp][placement][aim]") {
  struct Case { const char* moving; const char* target; };
  for (const Case c : {Case{"2780.dat", "3700.dat"}, Case{"3938.dat", "3937.dat"}, Case{"4085c.dat", "30374.dat"},
                       Case{"4519.dat", "32523.dat"}, Case{"3713.dat", "3705.dat"}, Case{"3001.dat", "3001.dat"}}) {
    bmapp::Session session;
    REQUIRE(session.newBlank().ok);
    REQUIRE(session.placePart(c.target, 4, {}, 0, session.generation(), session.version()).refused.empty());
    REQUIRE(session.placePart(c.moving, 1, {{}, {160, -40, 120}}, 0, session.generation(), session.version()).refused.empty());
    const std::unique_ptr<bmapp::AssemblyInspection> reader(bmapp::AssemblyInspection::capture(&session));
    const auto fits = reader->fits(1, 0);
    INFO(c.moving << " onto " << c.target);
    CHECK_FALSE(fits.empty());
    if (fits.empty()) continue;
    const auto applied = session.placeMoved({1}, 1, fits.front().pose, session.generation(), session.version());
    CHECK(applied.refused.empty());
    const std::unique_ptr<bmapp::AssemblyInspection> after(bmapp::AssemblyInspection::capture(&session));
    const auto report = after->inspect({1}, false, true);
    CHECK(report.joints.size() >= 1);
    CHECK(report.overlaps.empty());
  }
}
