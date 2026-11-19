#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include "bmapp/gizmo.h"

using namespace bmapp;
using Catch::Approx;

namespace {
constexpr double kPi = 3.14159265358979323846;
const Vec2 kView{800, 600};
const Mat3 kWorld{};
CameraState cam(double yaw = 0.6, double pitch = 0.45) {
  CameraState c;
  c.yaw = yaw, c.pitch = pitch, c.distance = 400;
  c.target = {10, -20, 30};
  return c;
}
const Vec3 kOrigin{10, -20, 30};
Vec3 plus(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec2 at(const CameraState& c, Vec3 offset) { return projectPoint(c, kView, plus(kOrigin, offset)); }
const Vec3 kSnap{20, 8, 20};
}  // namespace

TEST_CASE("X handle moves only in x", "[bmapp][gizmo]") {
  const CameraState c = cam();
  const Vec2 a = at(c, {}), b = at(c, {60, 0, 0});
  const Vec3 m = dragMove(c, kView, kOrigin, kWorld, Handle::X, a, b, kSnap);
  CHECK(m.x == 60);
  CHECK(m.y == 0);
  CHECK(m.z == 0);
  const Vec3 off = dragMove(c, kView, kOrigin, kWorld, Handle::X, a, {b.x + 4, b.y + 7}, kSnap);  // a little off the line
  CHECK(off.x == 60);
  CHECK(off.y == 0);
  CHECK(off.z == 0);
  const Vec3 back = dragMove(c, kView, kOrigin, kWorld, Handle::X, a, at(c, {-40, 0, 0}), kSnap);
  CHECK(back.x == -40);
}

TEST_CASE("snap rounds to studs and plates", "[bmapp][gizmo]") {
  const CameraState c = cam();
  const Vec2 a = at(c, {});
  CHECK(dragMove(c, kView, kOrigin, kWorld, Handle::X, a, at(c, {27, 0, 0}), kSnap).x == 20);
  CHECK(dragMove(c, kView, kOrigin, kWorld, Handle::X, a, at(c, {27, 0, 0}), {}).x == Approx(27).margin(0.01));  // Option: free
  CHECK(dragMove(c, kView, kOrigin, kWorld, Handle::Y, a, at(c, {0, -13, 0}), kSnap).y == -16);
  const Vec3 plane = dragMove(c, kView, kOrigin, kWorld, Handle::XZ, a, at(c, {31, 0, -9}), kSnap);
  CHECK(plane.x == 40);
  CHECK(plane.y == 0);
  CHECK(plane.z == 0);
  // Local axes: a piece turned 90 degrees about y moves along its own x, which is world -z.
  const Mat3 turned{{0, 0, 1, 0, 1, 0, -1, 0, 0}};
  const Vec3 local = dragMove(c, kView, kOrigin, turned, Handle::X, a, at(c, {0, 0, -40}), kSnap);
  CHECK(local.x == Approx(0).margin(1e-9));
  CHECK(local.z == Approx(-40));
}

TEST_CASE("a drag parallel to the line of sight moves nothing", "[bmapp][gizmo]") {
  const CameraState c = cam(0, 0);  // looking along +z
  const Vec2 a = at(c, {});
  const Vec3 m = dragMove(c, kView, kOrigin, kWorld, Handle::Z, a, {a.x + 50, a.y - 30}, kSnap);
  CHECK(m.x == 0);
  CHECK(m.y == 0);
  CHECK(m.z == 0);
  const Vec3 edgeOn = dragMove(c, kView, kOrigin, kWorld, Handle::XZ, a, {a.x + 50, a.y - 30}, {});  // the floor, seen edge-on
  CHECK(std::isfinite(edgeOn.x));
  CHECK(edgeOn.x == 0);
  CHECK(edgeOn.z == 0);
}

TEST_CASE("rotate snaps to 15 and is free with shift", "[bmapp][gizmo]") {
  const CameraState c = cam();
  const Vec2 o = at(c, {});
  const double t = 37 * kPi / 180;
  const Vec2 a{o.x + 100, o.y}, b{o.x + 100 * std::cos(t), o.y - 100 * std::sin(t)};  // counterclockwise on screen
  CHECK(dragRotate(c, kView, kOrigin, kWorld, Handle::View, a, b, false) == 30);
  CHECK(dragRotate(c, kView, kOrigin, kWorld, Handle::View, a, b, true) == Approx(37));
  CHECK(dragRotate(c, kView, kOrigin, kWorld, Handle::View, b, a, true) == Approx(-37));
  // -y is up, so the Y ring seen from above turns the other way to the screen.
  CHECK(dragRotate(c, kView, kOrigin, kWorld, Handle::Y, a, b, true) == Approx(-37));
  const Vec3 view = handleAxis(c, kWorld, Handle::View);
  CHECK(std::hypot(view.x, view.y, view.z) == Approx(1));
}

TEST_CASE("hitGizmo picks the nearest handle within tolerance, None outside", "[bmapp][gizmo]") {
  const CameraState c = cam();
  const GizmoShape move = gizmoShape(c, kView, kOrigin, kWorld, GizmoKind::Move);
  REQUIRE(move.lines.size() == 3);
  REQUIRE(move.rings.size() == 3);
  const GizmoSeg& x = move.lines[0];
  CHECK(x.h == Handle::X);
  CHECK(std::hypot(x.b.x - x.a.x, x.b.y - x.a.y) == Approx(kGizmoPoints).epsilon(0.2));
  CHECK(hitGizmo(move, x.b) == Handle::X);
  CHECK(move.lines[1].b.y < move.lines[1].a.y);  // the Y arm points up the screen: LDraw's up is -y
  CHECK(hitGizmo(move, {x.b.x + 3, x.b.y + 3}) == Handle::X);
  CHECK(hitGizmo(move, move.lines[1].b) == Handle::Y);
  CHECK(hitGizmo(move, {5, 5}) == Handle::None);
  // Inside a plane square.
  const auto& square = move.rings[0];
  Vec2 mid{};
  for (const Vec2& p : square) mid.x += p.x / square.size(), mid.y += p.y / square.size();
  CHECK(hitGizmo(move, mid) == move.ringHandles[0]);
  const GizmoShape turn = gizmoShape(c, kView, kOrigin, kWorld, GizmoKind::Rotate);
  REQUIRE(turn.rings.size() == 4);
  CHECK(turn.ringHandles[3] == Handle::View);
  CHECK(hitGizmo(turn, turn.rings[3][0]) == Handle::View);
  CHECK(gizmoShape(c, kView, kOrigin, kWorld, GizmoKind::None).rings.empty());
}

#include <filesystem>
#include <fstream>
#include "bmapp/session.h"

TEST_CASE("local axes are the piece's own, made unit", "[bmapp][gizmo]") {
  const auto path = std::filesystem::temp_directory_path() / "bmapp_turned.ldr";
  std::ofstream(path) << "1 4 0 0 0 0 0 2 0 1 0 -1 0 0 3001.dat\n";  // turned about y, stretched in its z
  bmapp::Session s;
  REQUIRE(s.open(path.string()).ok);
  const bmapp::Mat3 m = s.axesOf(0);
  const double want[9] = {0, 0, 1, 0, 1, 0, -1, 0, 0};
  for (int i = 0; i < 9; i++) CHECK(m.m[i] == Approx(want[i]).margin(1e-12));
  const bmapp::Mat3 none = s.axesOf(99);
  CHECK(none.m[0] == 1);
  CHECK(none.m[4] == 1);
}
