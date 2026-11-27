// Model checks, loose pieces, habit fits, fitting parts, seating and inventory over bmffi.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "bmffi.h"

using Catch::Matchers::WithinAbs;

namespace {

const BmMat3 kEye{{1, 0, 0, 0, 1, 0, 0, 0, 1}};

bool ok(BmChange c) {
  const bool fine = c.refused.len == 0;
  bm_change_free(c);
  return fine;
}

std::string take(BmString s) {
  std::string out = s.ptr ? std::string(s.ptr, s.len) : std::string();
  bm_string_free(s);
  return out;
}

BmSession* blankSession() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_new_blank(s);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

void place(BmSession* s, const char* part, int32_t color, BmVec3 pos) {
  REQUIRE(ok(bm_session_place_part(s, part, color, kEye, pos, 0, -1, bm_session_generation(s), bm_session_version(s))));
}

}  // namespace

TEST_CASE("loose pieces, choice rules, seating and part lookup", "[inspection]") {
  BmSession* s = blankSession();
  place(s, "3001.dat", 4, BmVec3{0, 0, 0});
  place(s, "3001.dat", 1, BmVec3{3, -24, 0});
  place(s, "3001.dat", 14, BmVec3{200, 0, 0});

  BmString name{}, desc{}, cat{};
  bm_session_part_at(s, 1, &name, &desc, &cat);
  CHECK(take(name) == "3001.dat");
  CHECK_FALSE(take(desc).empty());
  (void)take(cat);
  CHECK(bm_session_part_color(s, 1) == 1);

  const uint32_t hideOne = 2;
  bm_session_hide(s, &hideOne, 1);
  bm_session_show(s, &hideOne, 1);

  BmInspection* insp = bm_inspection_capture(s);
  REQUIRE(insp != nullptr);
  BmLoosePieces* loose = bm_inspection_loose_pieces(insp);
  REQUIRE(loose != nullptr);
  CHECK(std::string(bm_loose_pieces_error(loose)).empty());
  REQUIRE(bm_loose_pieces_len(loose) == 1);

  const BmLoosePiece row = bm_loose_pieces_at(loose, 0);
  CHECK(row.piece == 1);
  CHECK(row.onto == 0);
  CHECK(row.safe);
  CHECK_THAT(row.position.x, WithinAbs(0.0, 1e-6));
  CHECK_THAT(row.position.y, WithinAbs(-24.0, 1e-6));

  uint32_t init[4]{};
  CHECK(bm_loose_initial_choice(loose, init, 4) == 1);
  CHECK(init[0] == 1);
  CHECK(bm_loose_waiting_on(loose, 1, init, 1) == BM_NO_PIECE);
  uint32_t afterUncheck[4]{};
  CHECK(bm_loose_uncheck(loose, 1, init, 1, afterUncheck, 4) == 0);
  CHECK(take(bm_loose_detail(loose, 0, "Red Brick 2 x 4")).find("on Red Brick 2 x 4") != std::string::npos);

  const BmPieceMove move{row.piece, row.rotation, row.position};
  const uint64_t gen = bm_session_generation(s), ver = bm_session_version(s);
  CHECK_FALSE(ok(bm_session_seat_pieces(s, &move, 1, gen, ver + 1)));
  REQUIRE(ok(bm_session_seat_pieces(s, &move, 1, gen, ver)));
  CHECK(bm_session_can_undo(s));

  bm_loose_pieces_free(loose);
  bm_inspection_free(insp);

  BmInspection* insp2 = bm_inspection_capture(s);
  BmLoosePieces* loose2 = bm_inspection_loose_pieces(insp2);
  CHECK(bm_loose_pieces_len(loose2) == 0);
  bm_loose_pieces_free(loose2);
  bm_inspection_free(insp2);
  bm_session_free(s);
}

TEST_CASE("model checks report overlaps, habit fits and fitting parts", "[inspection]") {
  BmSession* s = blankSession();
  place(s, "3001.dat", 4, BmVec3{0, 0, 0});
  place(s, "3001.dat", 1, BmVec3{0, 0, 0});

  BmInspection* insp = bm_inspection_capture(s);
  REQUIRE(insp != nullptr);
  BmModelChecks* checks = bm_inspection_check_model(insp);
  REQUIRE(checks != nullptr);
  CHECK(std::string(bm_model_checks_error(checks)).empty());

  bool foundOverlap = false;
  for (size_t i = 0; i < bm_model_checks_len(checks); ++i) {
    if (bm_model_checks_kind(checks, i) == 0) {
      uint32_t pieces[4]{};
      const size_t n = bm_model_checks_pieces(checks, i, pieces, 4);
      if (n == 2 && pieces[0] == 0 && pieces[1] == 1) foundOverlap = true;
    }
  }
  CHECK(foundOverlap);
  bm_model_checks_free(checks);

  BmHabitFits* habits = bm_inspection_habit_fits(insp, 0, 8);
  REQUIRE(habits != nullptr);
  if (bm_habit_fits_len(habits) > 0) {
    CHECK_FALSE(std::string(bm_habit_fits_name(habits, 0)).empty());
    CHECK(std::string(bm_habit_fits_why(habits, 0)).rfind("In ", 0) == 0);
  }
  bm_habit_fits_free(habits);

  const char* candidates[] = {"3001.dat", "3003.dat"};
  BmFittingParts* fitting = bm_inspection_fitting_parts(insp, 0, candidates, 2, 10);
  REQUIRE(fitting != nullptr);
  CHECK(bm_fitting_parts_len(fitting) >= 1);
  bm_fitting_parts_free(fitting);

  bm_inspection_free(insp);
  bm_session_free(s);
}

TEST_CASE("inventory capture, prepare and import over bmffi", "[inspection]") {
  BmSession* s = blankSession();
  place(s, "3001.dat", 4, BmVec3{0, 0, 0});

  const auto tick = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto csv = std::filesystem::temp_directory_path() / ("bmffi-inv-" + std::to_string(tick) + ".csv");
  {
    std::ofstream out(csv, std::ios::binary);
    out << "\"Quantity\",Color,Part,Is Spare\n"
           "2,4,\"3001.DAT\",False\n"
           "5,7,3022,yes\n"
           "2,4,brickmotion_unknown_part,false\n"
           "x,1,3001,false\n";
  }

  BmInventory* inv = bm_inventory_capture(s, 0);
  REQUIRE(inv != nullptr);
  BmInventoryReport* rep = bm_inventory_prepare(inv, csv.string().c_str());
  REQUIRE(rep != nullptr);
  CHECK(std::string(bm_inventory_report_error(rep)).empty());
  CHECK(bm_inventory_report_pieces(rep) == 2);
  CHECK(bm_inventory_report_spares(rep) == 5);
  CHECK(bm_inventory_report_invalid_rows(rep) == 1);
  REQUIRE(bm_inventory_report_missing_len(rep) == 1);
  CHECK(std::string(bm_inventory_report_missing_at(rep, 0)) == "brickmotion_unknown_part.dat");
  bm_inventory_report_free(rep);

  const size_t before = bm_session_piece_count(s);
  REQUIRE(ok(bm_session_import_inventory(s, inv)));
  CHECK(bm_session_piece_count(s) == before + 2);
  bm_inventory_free(inv);

  std::error_code ec;
  std::filesystem::remove(csv, ec);
  bm_session_free(s);
}

TEST_CASE("joint info and extended joint edits over bmffi", "[inspection][joints]") {
  BmSession* s = blankSession();
  place(s, "3937.dat", 4, {0, 0, 0});
  place(s, "3938.dat", 14, {0, 0, 0});
  place(s, "3001.dat", 1, {400, 0, 0});
  BmInspection* insp = bm_inspection_capture(s);
  REQUIRE(insp);

  BmJointInfoHandle* info = bm_inspection_joint_info(insp, 0, 1, true);
  REQUIRE(info);
  CHECK(std::string(bm_joint_info_error(info)).empty());
  const BmJointInfo d = bm_joint_info_data(info);
  CHECK(d.can_turn);
  CHECK_FALSE(d.can_slide);
  CHECK(d.max_deg > 80);
  CHECK(d.min_deg < 0);
  uint32_t pieces[4] = {};
  REQUIRE(bm_joint_info_pieces(info, pieces, 4) == 1);
  CHECK(pieces[0] == 1);
  CHECK_FALSE(std::string(bm_joint_info_max_blocker(info)).empty());
  CHECK(bm_joint_info_min_blocker(info) != nullptr);
  bm_joint_info_free(info);

  BmJointInfoHandle* apart = bm_inspection_joint_info(insp, 0, 2, true);
  CHECK(std::string(bm_joint_info_error(apart)) == "The two parts are no longer connected.");
  bm_joint_info_free(apart);

  BmJointEdit* turned = bm_inspection_change_joint_ex(insp, 0, 1, 120, 0, BmVec3{0, 0, 0}, false);
  REQUIRE(turned);
  CHECK(std::string(bm_joint_edit_error(turned)).empty());
  REQUIRE(bm_joint_edit_pieces(turned, pieces, 4) == 1);
  bm_joint_edit_free(turned);

  BmJointEdit* slid = bm_inspection_change_joint_ex(insp, 0, 1, 0, 8, BmVec3{0, 0, 0}, false);
  CHECK(std::string(bm_joint_edit_error(slid)) == "This connection cannot slide.");
  bm_joint_edit_free(slid);

  bm_joint_info_free(nullptr);
  bm_inspection_free(insp);
  bm_session_free(s);
}

TEST_CASE("pose readback and Fit Together over bmffi", "[inspection][p3]") {
  BmSession* s = blankSession();
  place(s, "3001.dat", 4, BmVec3{0, 0, 0});
  place(s, "3001.dat", 1, BmVec3{200, -96, 40});

  const BmPieceMove p = bm_session_pose_of(s, 1);
  CHECK(p.piece == 1);
  CHECK_THAT(p.position.x, WithinAbs(200, 1e-9));
  CHECK_THAT(p.position.y, WithinAbs(-96, 1e-9));
  CHECK_THAT(p.position.z, WithinAbs(40, 1e-9));
  CHECK_THAT(p.rotation.m[0], WithinAbs(1, 1e-9));
  CHECK_THAT(p.rotation.m[4], WithinAbs(1, 1e-9));

  // Scale shows in the rotation's column lengths.
  uint32_t one[] = {1};
  REQUIRE(ok(bm_session_scale(s, one, 1, BmVec3{2, 1, 1}, kEye, p.position, false)));
  const BmPieceMove scaled = bm_session_pose_of(s, 1);
  CHECK_THAT(scaled.rotation.m[0], WithinAbs(2, 1e-9));
  // Out of range: identity at the origin.
  const BmPieceMove none = bm_session_pose_of(s, 99);
  CHECK_THAT(none.rotation.m[0], WithinAbs(1, 1e-9));
  CHECK_THAT(none.position.x, WithinAbs(0, 1e-9));
  bm_session_free(s);

  // Two plain bricks apart: Fit Together finds a seat for the second on the first.
  BmSession* t = blankSession();
  place(t, "3001.dat", 4, BmVec3{0, 0, 0});
  place(t, "3001.dat", 1, BmVec3{300, -200, 0});
  BmInspection* insp = bm_inspection_capture(t);
  REQUIRE(insp != nullptr);
  BmPieceMove fits[8]{};
  const size_t n = bm_inspection_fits(insp, 1, 0, fits, 8);
  CHECK(n >= 1);
  CHECK(fits[0].piece == 1);
  // A seated 2x4 sits a brick's height (24 LDU) above or below the first.
  CHECK_THAT(std::abs(fits[0].position.y), WithinAbs(24, 1e-6));
  CHECK(bm_inspection_fits(insp, 1, 0, nullptr, 0) == n);
  CHECK(bm_inspection_fits(nullptr, 1, 0, fits, 8) == 0);
  bm_inspection_free(insp);
  bm_session_free(t);
}
