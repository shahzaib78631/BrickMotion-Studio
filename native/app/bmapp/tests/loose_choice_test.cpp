#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include "bmapp/assembly_inspection.h"

namespace {

bmapp::LoosePiece row(uint32_t piece, uint32_t onto, bool safe, double offset = 0, double angle = 0,
                      std::string note = {}) {
  bmapp::LoosePiece r;
  r.piece = piece;
  r.onto = onto;
  r.safe = safe;
  r.offset = offset;
  r.angle = angle;
  r.note = std::move(note);
  return r;
}

}  // namespace

TEST_CASE("loose_choice_rules", "[bmapp][correct]") {
  // A (safe, onto 9 unlisted), B (safe, onto A), C (unsafe, onto 9), D (safe, onto C).
  const uint32_t A = 1, B = 2, C = 3, D = 4;
  const bmapp::LoosePieceList rows = {
      row(A, 9, true),
      row(B, A, true),
      row(C, 9, false),
      row(D, C, true),
  };

  const auto init = bmapp::initialLooseChoice(rows);
  CHECK(init == bmapp::PieceList{A, B});

  CHECK(bmapp::looseWaitingOn(rows, D, {A, B}) == C);
  CHECK(bmapp::looseWaitingOn(rows, B, {A, B}) == UINT32_MAX);
  CHECK(bmapp::looseWaitingOn(rows, B, {}) == A);

  CHECK(bmapp::looseUncheck(rows, A, {A, B}).empty());
  CHECK(bmapp::looseUncheck(rows, B, {A, B}) == bmapp::PieceList{A});

  // Two-row cycle (E onto F, F onto E, both safe) returns without hanging and keeps both.
  const uint32_t E = 10, F = 11;
  const bmapp::LoosePieceList cycle = {
      row(E, F, true),
      row(F, E, true),
  };
  const auto cycleInit = bmapp::initialLooseChoice(cycle);
  CHECK(cycleInit == bmapp::PieceList{E, F});
  CHECK(bmapp::looseWaitingOn(cycle, E, {E, F}) == UINT32_MAX);
  CHECK(bmapp::looseWaitingOn(cycle, E, {}) == F);
  CHECK(bmapp::looseUncheck(cycle, E, {E, F}).empty());
}

TEST_CASE("loose_detail_and_habit_why", "[bmapp][correct][suggest]") {
  CHECK(bmapp::looseDetail(row(1, 0, true, 3.0, 0.0), "Blue Brick 2 x 4") ==
        "3.0 LDU off \xc2\xb7 on Blue Brick 2 x 4");

  CHECK(bmapp::looseDetail(row(1, 0, true, 1.5, 4.2), "Red Plate 1 x 2") ==
        "1.5 LDU off \xc2\xb7 turned 4.2\xc2\xb0 \xc2\xb7 on Red Plate 1 x 2");

  const auto unsafeDefault = bmapp::looseDetail(row(1, 0, false, 2.0, 0.0), "Blue Brick 2 x 4");
  CHECK(unsafeDefault.ends_with(" \xc2\xb7 would cross another part"));

  const auto unsafeNote = bmapp::looseDetail(row(1, 0, false, 2.0, 0.0, "blocked by pin"), "Blue Brick 2 x 4");
  CHECK(unsafeNote.ends_with(" \xc2\xb7 blocked by pin"));

  bmapp::HabitFit stud;
  stud.models = 1234;
  stud.total = 67185;
  stud.joint = "stud";
  CHECK(bmapp::habitWhy(stud) == "In 1,234 of 67,185 BrickNet models");

  bmapp::HabitFit hinge = stud;
  hinge.joint = "hinge";
  CHECK(bmapp::habitWhy(hinge) == "In 1,234 of 67,185 BrickNet models \xc2\xb7 hinge");
}
