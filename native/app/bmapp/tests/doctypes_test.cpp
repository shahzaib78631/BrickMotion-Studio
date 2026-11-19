#include <catch2/catch_test_macros.hpp>
#include "bmapp/doctypes.h"

TEST_CASE("document types list project then imports", "[bmapp]") {
  const std::vector<bmapp::DocType> types = bmapp::documentTypes();
  std::vector<std::string> utis, extensions;
  for (const bmapp::DocType& t : types) utis.push_back(t.uti), extensions.push_back(t.extension);
  CHECK(utis == std::vector<std::string>{"com.brickmotion.project", "com.brickmotion.plan", "com.ldraw.model", "com.ldraw.mpd", "com.ldraw.part", "com.stud.io"});
  CHECK(extensions == std::vector<std::string>{"brickmotion", "json", "ldr", "mpd", "dat", "io"});
  REQUIRE_FALSE(types.empty());
  CHECK(types[0].project);
  for (size_t i = 1; i < types.size(); i++) CHECK_FALSE(types[i].project);
  for (const bmapp::DocType& t : types) CHECK_FALSE(t.name.empty());
}

TEST_CASE("a type is found by its extension, case aside", "[bmapp]") {
  CHECK(bmapp::isProjectExtension("brickmotion"));
  CHECK(bmapp::isProjectExtension("BrickMotion"));
  CHECK_FALSE(bmapp::isProjectExtension("ldr"));
  CHECK_FALSE(bmapp::isProjectExtension(""));
}
