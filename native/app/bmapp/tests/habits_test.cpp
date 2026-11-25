#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include <memory>
#include "bmapp/assembly_inspection.h"
#include "bmapp/session.h"
#include "habits.h"

namespace {

std::unique_ptr<bmapp::AssemblyInspection> inspect(bmapp::Session& session) {
  return std::unique_ptr<bmapp::AssemblyInspection>(bmapp::AssemblyInspection::capture(&session));
}

const bmapp::HabitFit* find(const std::vector<bmapp::HabitFit>& fits, const std::string& part) {
  for (const auto& fit : fits)
    if (fit.name == part) return &fit;
  return nullptr;
}

}  // namespace

TEST_CASE("the habits table reads with variant fallback", "[bmapp][suggest]") {
  const auto table = bmapp::loadHabits(bmapp::defaultHabitsFile());
  REQUIRE(table);
  CHECK(table->models > 60000);
  REQUIRE(table->of("3001.dat"));
  CHECK(table->of("3001.dat") == table->of("3001"));
  // 3001b is not in the table under its own name; it falls back to 3001.
  CHECK(table->of("3001b.dat") == table->of("3001"));
  CHECK(table->of("no-such-part.dat") == nullptr);
  CHECK(bmapp::loadHabits("/nonexistent/habits.json") == nullptr);
}

TEST_CASE("builder suggestions mate the target at the surveyed pose and overlap nothing", "[bmapp][suggest]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3003.dat", 1, {{}, {200, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  REQUIRE(session.placePart("3003.dat", 1, {{}, {260, 0, 0}}, 0, session.generation(), session.version()).refused.empty());

  const auto fits = inspect(session)->habitFits(0, 12);
  REQUIRE_FALSE(fits.empty());
  CHECK(fits.size() <= 12);
  for (size_t i = 1; i < fits.size(); ++i) CHECK(fits[i - 1].models >= fits[i].models);
  const auto* brick = find(fits, "3001.dat");
  REQUIRE(brick);
  CHECK(brick->links > 0);
  CHECK(brick->description == "Brick  2 x  4");
  CHECK(brick->total == bmapp::loadHabits(bmapp::defaultHabitsFile())->models);
  CHECK(brick->color == 4);  // builders match a 2 × 4 brick's colour most of the time
  CHECK(std::abs(brick->pose.position.y) == Catch::Approx(24));
  // Only one entry per part.
  size_t bricks = 0;
  for (const auto& fit : fits) bricks += fit.name == "3001.dat";
  CHECK(bricks == 1);

  // A brick already on top takes that spot, so the suggestion moves elsewhere.
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, -24, 0}}, 0, session.generation(), session.version()).refused.empty());
  const auto stacked = inspect(session)->habitFits(0, 40);
  for (const auto& fit : stacked)
    CHECK_FALSE((fit.name == "3001.dat" && fit.pose.position.y == Catch::Approx(-24) && fit.pose.position.x == Catch::Approx(0)));

  // Placing a suggestion is one undoable step at its exact pose.
  const auto& first = fits.front();
  const auto count = session.pieceCount();
  REQUIRE(session.placePart(first.name, first.color, first.pose, 0, session.generation(), session.version()).refused.empty());
  CHECK(session.pieceCount() == count + 1);
  session.undo();
  CHECK(session.pieceCount() == count);
}

TEST_CASE("builder suggestions follow a turned and moved anchor", "[bmapp][suggest]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  // A quarter turn about the vertical, away from the origin.
  bmapp::PartPose turned{{{0, 0, 1, 0, 1, 0, -1, 0, 0}}, {120, -48, 40}};
  REQUIRE(session.placePart("3001.dat", 4, turned, 0, session.generation(), session.version()).refused.empty());
  const auto fits = inspect(session)->habitFits(0, 12);
  const auto* brick = find(fits, "3001.dat");
  REQUIRE(brick);
  CHECK(brick->links > 0);
  // Stacked directly on (or under) the turned brick, turned the same way.
  CHECK(brick->pose.position.x == Catch::Approx(120));
  CHECK(brick->pose.position.z == Catch::Approx(40));
  CHECK(std::abs(brick->pose.position.y + 48) == Catch::Approx(24));
  for (int i = 0; i < 9; ++i) CHECK(brick->pose.rotation.m[i] == Catch::Approx(turned.rotation.m[i]).margin(1e-9));
  // A part that sits off-centre lands along the turned brick's long side (world z), not world x.
  bool alongZ = false;
  for (const auto& fit : fits)
    if (std::abs(fit.pose.position.z - 40) > 5 && std::abs(fit.pose.position.x - 120) < 1e-6) alongZ = true;
  CHECK(alongZ);
}

TEST_CASE("builder suggestions are empty for an unknown target", "[bmapp][suggest]") {
  bmapp::Session session;
  REQUIRE(session.newBlank().ok);
  REQUIRE(session.placePart("3001.dat", 4, {{}, {0, 0, 0}}, 0, session.generation(), session.version()).refused.empty());
  const auto reader = inspect(session);
  CHECK(reader->habitFits(7, 10).empty());
  CHECK(reader->habitFits(0, 0).empty());
}
