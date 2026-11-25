#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "bmapp/timeline_view.h"

using Catch::Matchers::WithinAbs;

namespace {
bmapp::TimelineView view600() {
  bmapp::TimelineView v;
  v.viewportWidth = 600;
  return v;
}
}  // namespace

TEST_CASE("timeline view magnify keeps the anchor under the pointer", "[timeline view]") {
  bmapp::TimelineView v = view600();
  const double before = v.timeAt(300, 100);
  CHECK_THAT(before, WithinAbs(50, 1e-9));
  REQUIRE(v.magnify(4, 300));
  CHECK(v.zoom == 4);
  CHECK_THAT(v.offset, WithinAbs(864, 1e-9));
  CHECK_THAT(v.timeAt(300, 100), WithinAbs(before, 1e-9));
  CHECK_FALSE(v.magnify(1, 300));
}

TEST_CASE("timeline view zoom is clamped to 1…64", "[timeline view]") {
  bmapp::TimelineView v = view600();
  v.magnify(1000, 0);
  CHECK(v.zoom == 64);
  v.magnify(0.0001, 0);
  CHECK(v.zoom == 1);
  CHECK(v.offset == 0);
  CHECK_FALSE(v.magnify(0, 10));
  CHECK_FALSE(v.magnify(-2, 10));
}

TEST_CASE("timeline view reveal scrolls only past the margins", "[timeline view]") {
  bmapp::TimelineView v = view600();
  v.magnify(4, 12);  // anchored at the start
  REQUIRE(v.offset == 0);
  // logical width 2304 for 100 s: 10 s is x 230.4 + 12, well inside.
  CHECK_FALSE(v.reveal(10, 100, false));
  // 50 s is x 1152 + 12: past the right margin, scrolls to put it at 72 %.
  REQUIRE(v.reveal(50, 100, false));
  CHECK_THAT(v.offset, WithinAbs(1164 - 600 * 0.72, 1e-9));
  REQUIRE(v.reveal(80, 100, true));
  CHECK_THAT(v.offset, WithinAbs(0.8 * 2304 + 12 - 300, 1e-9));
  CHECK(v.visibleStart() < 0.8);
  CHECK(v.visibleEnd() > 0.8);
}

TEST_CASE("timeline view panAtEdge speed is 2…28", "[timeline view]") {
  bmapp::TimelineView v = view600();
  v.magnify(4, 12);
  v.offset = 500;
  REQUIRE(v.panAtEdge(599));
  CHECK_THAT(v.offset, WithinAbs(525.5, 1e-9));
  REQUIRE(v.panAtEdge(551));
  CHECK_THAT(v.offset, WithinAbs(527.5, 1e-9));
  REQUIRE(v.panAtEdge(-100));
  CHECK_THAT(v.offset, WithinAbs(499.5, 1e-9));
  CHECK_FALSE(v.panAtEdge(300));
  v.offset = 0;
  CHECK_FALSE(v.panAtEdge(0));  // already at the start
}

TEST_CASE("timeline view fit and widths", "[timeline view]") {
  bmapp::TimelineView v = view600();
  CHECK(v.logicalWidth() == 576);
  CHECK(v.contentWidth() == 600);
  CHECK(v.maximumOffset() == 0);
  v.magnify(2, 100);
  REQUIRE(v.fit());
  CHECK(v.zoom == 1);
  CHECK(v.offset == 0);
  CHECK_FALSE(v.fit());
  CHECK_THAT(v.x(25, 100), WithinAbs(144, 1e-9));
}

TEST_CASE("timeline view tickInterval is 1-2-5", "[timeline view]") {
  CHECK(bmapp::tickInterval(100, 760) == 10);
  CHECK_THAT(bmapp::tickInterval(100, 1000), WithinAbs(10, 1e-9));   // minimum 7.6
  CHECK_THAT(bmapp::tickInterval(60, 3000), WithinAbs(2, 1e-9));     // minimum 1.52
  CHECK_THAT(bmapp::tickInterval(60, 1500), WithinAbs(5, 1e-9));     // minimum 3.04
}
