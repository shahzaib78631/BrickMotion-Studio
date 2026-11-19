// Focus: one submodel opened to be edited on its own.
#include <catch2/catch_test_macros.hpp>
#include "structure_fixture.h"

using namespace structure;

TEST_CASE("focus shows one submodel", "[bmapp][focus]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  REQUIRE(s.pieceCount() == 7);
  s.select({0}, bmapp::SelectMode::Replace);
  s.focus({"Pair"});
  CHECK(s.pieceCount() == 2);
  CHECK(s.focused() == "Pair");
  CHECK(s.focusPath() == bmapp::StringList{"Pair"});
  CHECK(s.snapshot().focus == "Pair");
  CHECK(s.selection().empty());
  CHECK(s.stepCount() == 2);
  s.insertStep(0);
  CHECK(plan(s)["submodels"]["Pair"]["steps"].size() == 3);
  CHECK(plan(s)["steps"].size() == 2);
  s.focus({});
  CHECK(s.pieceCount() == 7);
  CHECK(s.snapshot().focus.empty());
  s.focus({"Nowhere"});  // no such def: the root
  CHECK(s.focusPath().empty());
}

TEST_CASE("undo that removes the focused def falls back", "[bmapp][focus]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  REQUIRE(s.makeSubmodel({pieces(s, "a")[0], pieces(s, "b")[0]}, "AB").refused.empty());
  s.focus({"AB"});
  CHECK(s.pieceCount() == 2);
  s.undo();
  CHECK(s.focusPath().empty());
  CHECK(s.pieceCount() == 7);
  s.redo();
  CHECK(s.pieceCount() == 7);  // focus stays where it fell back to
}

TEST_CASE("rename on the path", "[bmapp][focus]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  s.focus({"Pair"});
  REQUIRE(s.renameSubmodel("Pair", "Twin").refused.empty());
  CHECK(s.focusPath() == bmapp::StringList{"Twin"});
  CHECK(s.pieceCount() == 2);
  s.undo();
  CHECK(s.focusPath() == bmapp::StringList{"Pair"});
  CHECK(s.pieceCount() == 2);
}

TEST_CASE("commands act on the focused model", "[bmapp][focus]") {
  bmapp::Session s;
  REQUIRE(s.open(fixture().string()).ok);
  s.focus({"Pair"});
  s.paste(s.copy({0}), {0, 0, 0});
  CHECK(plan(s)["submodels"]["Pair"]["steps"][1]["pieces"].size() == 2);
  CHECK(s.pieceCount() == 3);
  s.focus({});
  CHECK(s.pieceCount() == 9);  // both uses show the pasted piece
}
