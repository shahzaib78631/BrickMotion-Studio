// Submodels, groups, scale and import-into over bmffi.
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "bmffi.h"

namespace {

const BmMat3 kEye{{1, 0, 0, 0, 1, 0, 0, 0, 1}};

std::string take(BmString s) {
  std::string out = s.ptr ? std::string(s.ptr, s.len) : std::string();
  bm_string_free(s);
  return out;
}

std::string refusal(BmChange c) {
  std::string out = c.refused.ptr ? std::string(c.refused.ptr, c.refused.len) : std::string();
  bm_change_free(c);
  return out;
}

BmSession* threeBricks() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_new_blank(s);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  for (float x : {0.f, 80.f, 160.f})
    REQUIRE(refusal(bm_session_place_part(s, "3001.dat", 4, kEye, BmVec3{x, -24, 0}, 0, -1, bm_session_generation(s),
                                          bm_session_version(s)))
                .empty());
  REQUIRE(bm_session_piece_count(s) == 3);
  return s;
}

std::string freeName(BmSession* s, const char* preferred) { return take(bm_session_free_submodel_name(s, preferred)); }

}  // namespace

TEST_CASE("make, extract, rename and delete submodels", "[submodels]") {
  BmSession* s = threeBricks();
  const uint32_t two[] = {0, 1};
  CHECK(freeName(s, "Wing") == "Wing");
  CHECK(refusal(bm_session_make_submodel(s, two, 2, "Wing")).empty());
  CHECK(take(bm_session_undo_name(s)) == "Make Submodel");
  CHECK(bm_session_piece_count(s) == 3);
  CHECK(freeName(s, "Wing") == "Wing 2");
  CHECK_FALSE(refusal(bm_session_delete_submodel(s, "Wing")).empty());  // still used

  // The new use stays selected; extracting it puts its bricks back.
  uint32_t sel[4] = {};
  REQUIRE(bm_session_selection(s, sel, 4) >= 1);
  CHECK(refusal(bm_session_extract(s, sel[0])).empty());
  CHECK(bm_session_piece_count(s) == 3);
  CHECK(refusal(bm_session_rename_submodel(s, "Wing", "Fin")).empty());
  CHECK(freeName(s, "Wing") == "Wing");
  CHECK(freeName(s, "Fin") == "Fin 2");
  CHECK(refusal(bm_session_delete_submodel(s, "Fin")).empty());
  CHECK(freeName(s, "Fin") == "Fin");

  CHECK(refusal(bm_session_new_submodel(s, "Empty")).empty());
  CHECK(freeName(s, "Empty") == "Empty 2");
  bm_session_free(s);
}

TEST_CASE("move to model and make unique", "[submodels]") {
  BmSession* s = threeBricks();
  const uint32_t first[] = {0};
  CHECK(refusal(bm_session_make_submodel(s, first, 1, "Pod")) == "Choose at least two pieces.");
  const uint32_t pair[] = {0, 1};
  REQUIRE(refusal(bm_session_make_submodel(s, pair, 2, "Pod")).empty());
  // The use's two pieces stay selected; the loose brick is the one left out.
  uint32_t sel[4] = {};
  REQUIRE(bm_session_selection(s, sel, 4) == 2);
  const uint32_t use = sel[0];
  uint32_t other = 0;
  while (other == sel[0] || other == sel[1]) ++other;
  const uint32_t move[] = {other};
  CHECK(refusal(bm_session_move_to_model(s, move, 1, "Pod")).empty());
  CHECK(bm_session_piece_count(s) == 3);
  CHECK(take(bm_session_undo_name(s)) == "Move Piece to Pod");

  const uint32_t dup[] = {use};
  REQUIRE(refusal(bm_session_duplicate(s, dup, 1, BmVec3{0, 0, 200})).empty());
  CHECK(refusal(bm_session_make_unique(s, use)).empty());
  CHECK(freeName(s, "Pod 2") == "Pod 2 2");  // the fork took "Pod 2"
  bm_session_free(s);
}

TEST_CASE("groups name, list and select pieces", "[submodels][groups]") {
  BmSession* s = threeBricks();
  const uint32_t pair[] = {1, 2};
  CHECK(take(bm_session_group_names(s)).empty());
  CHECK(refusal(bm_session_set_group(s, pair, 2, "Wheels")).empty());
  CHECK(take(bm_session_group_names(s)) == "Wheels");
  const uint32_t one[] = {1};
  CHECK(take(bm_session_groups_of(s, one, 1)) == "Wheels");
  bm_session_select_group(s, "Wheels");
  uint32_t sel[4] = {};
  REQUIRE(bm_session_selection(s, sel, 4) == 2);
  CHECK(sel[0] == 1);
  CHECK(sel[1] == 2);
  CHECK(refusal(bm_session_set_group(s, one, 1, "")).empty());
  CHECK(take(bm_session_groups_of(s, one, 1)).empty());
  bm_session_select_group(nullptr, "x");
  bm_session_free(s);
}

TEST_CASE("scale is one undo step and refuses bad factors", "[submodels][scale]") {
  BmSession* s = threeBricks();
  const uint32_t one[] = {0};
  CHECK(refusal(bm_session_scale(s, one, 1, BmVec3{2, 2, 2}, kEye, BmVec3{0, -24, 0}, false)).empty());
  CHECK(take(bm_session_undo_name(s)) == "Scale Piece");
  CHECK_FALSE(refusal(bm_session_scale(s, one, 1, BmVec3{-1, 1, 1}, kEye, BmVec3{0, 0, 0}, false)).empty());
  bm_session_free(s);
}

TEST_CASE("import a model file into the open one", "[submodels][import]") {
  const auto dir = std::filesystem::temp_directory_path() / "bmffi-import-test";
  std::filesystem::create_directories(dir);
  const auto file = dir / "two.ldr";
  std::ofstream(file) << "0 Two\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 2 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n";

  BmModelImport* bad = bm_model_import_read("/no/such/file.ldr");
  REQUIRE(bad);
  CHECK_FALSE(std::string(bm_model_import_error(bad)).empty());
  bm_model_import_free(bad);

  BmSession* s = threeBricks();
  BmModelImport* imp = bm_model_import_read(file.c_str());
  REQUIRE(imp);
  CHECK(std::string(bm_model_import_error(imp)).empty());
  CHECK(refusal(bm_session_import_model(s, imp, "", bm_session_generation(s))).empty());
  CHECK(bm_session_piece_count(s) == 5);
  bm_model_import_free(imp);
  bm_model_import_free(nullptr);
  bm_session_free(s);
  std::filesystem::remove_all(dir);
}
